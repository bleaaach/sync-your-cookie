import { MessageErrorCode } from '@lib/message';
import { accountStorage, type AccountInfo } from '@sync-your-cookie/storage/lib/accountStorage';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import type { ICookiesMap } from '@sync-your-cookie/protobuf';

import { readCloudflareKVByKey } from '../cloudflare/api';
import { readCookiesMap, mergeAndWriteMultipleDomainCookies } from './withCloudflare';
import type { ICookie, ILocalStorageItem } from '@sync-your-cookie/protobuf';
import {
  base64ToArrayBuffer,
  decodeCookiesMap,
  decryptBase64,
  isBase64Encrypted,
} from '@sync-your-cookie/protobuf';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';

const decodeRawContent = async (content: string): Promise<ICookiesMap> => {
  const settingsInfo = settingsStorage.getSnapshot();
  const encryptionEnabled = settingsInfo?.encryptionEnabled;
  const encryptionPassword = settingsInfo?.encryptionPassword;

  let processedContent = content;
  const protobufEncoding = !content.startsWith('{');

  if (protobufEncoding && isBase64Encrypted(content)) {
    if (!encryptionEnabled || !encryptionPassword) {
      throw new Error('Failed to decrypt data. Please check your encryption password.');
    }
    processedContent = await decryptBase64(content, encryptionPassword);
  }
  if (protobufEncoding) {
    const compressedBuffer = base64ToArrayBuffer(processedContent);
    const deMsg = await decodeCookiesMap(compressedBuffer);
    return JSON.parse(JSON.stringify(deMsg));
  }
  return JSON.parse(processedContent);
};

/**
 * Pull cookies from the cloud backend (Cloudflare KV / GitHub Gist) for the
 * currently active `settingsStorage.storageKey`, and merge them into the local
 * `cookieStorage`.
 *
 * Merge strategy: per-domain, cookies are merged by (domain, name); localStorageItems
 * are merged by (key). On conflict the remote value wins.
 *
 * Used after a fresh extension install to restore the user's tracked sites
 * without having to add each one manually.
 */
export const pullAndMergeToLocal = async (
  accountInfo?: AccountInfo,
): Promise<{
  remote: ICookiesMap;
  counts: {
    domainsAdded: number;
    domainsMerged: number;
    cookiesAdded: number;
    cookiesOverridden: number;
    localStorageMerged: number;
  };
}> => {
  const acc = accountInfo || accountStorage.getSnapshot();
  if (!acc) {
    return Promise.reject({
      message: 'Account info is empty',
      code: MessageErrorCode.AccountCheck,
    });
  }
  const remote = await readCookiesMap(acc);
  // `readCookiesMap` returns an ICookiesMap that may still be a protobufjs
  // Message instance for nested fields; round-trip through JSON to guarantee
  // a plain object everywhere downstream (Object.entries / spread / storage).
  const plainRemote: ICookiesMap = JSON.parse(JSON.stringify(remote || {}));
  const counts = await cookieStorage.mergeFromRemote(plainRemote);
  return { remote: plainRemote, counts };
};

/**
 * Aggregate cookies from MULTIPLE cloud storage keys into local cookieStorage.
 *
 * Useful right after reinstall, when:
 *   - the user had several storageKeys (e.g. one per environment)
 *   - or wants to bring back sites from a key that wasn't the active one.
 *
 * For Cloudflare, lists all keys in the namespace and reads each one whose
 * value starts with `{` or decodes as a protobuf ICookiesMap.
 *
 * For GitHub, the gist is a single file (active storageKey only); this is a
 * no-op in that case and the caller should use `pullAndMergeToLocal`.
 */
export const pullAndMergeAllStorageKeys = async (
  accountInfo?: AccountInfo,
): Promise<{
  perKey: Array<{ storageKey: string; remote: ICookiesMap; counts: { domainsAdded: number; domainsMerged: number; cookiesAdded: number; cookiesOverridden: number; localStorageMerged: number } }>;
  total: { domainsAdded: number; domainsMerged: number; cookiesAdded: number; cookiesOverridden: number; localStorageMerged: number };
  keysScanned: number;
  keysMerged: number;
}> => {
  const acc = accountInfo || accountStorage.getSnapshot();
  if (!acc) {
    return Promise.reject({
      message: 'Account info is empty',
      code: MessageErrorCode.AccountCheck,
    });
  }
  if (acc.selectedProvider === 'github') {
    // GitHub Gist = one file per storageKey, but only ONE storageKey is the
    // currently active one at a time. Best we can do here is pull the active key.
    const { remote, counts } = await pullAndMergeToLocal(acc);
    return {
      perKey: [{ storageKey: settingsStorage.getSnapshot()?.storageKey || '(active)', remote, counts }],
      total: counts,
      keysScanned: 1,
      keysMerged: 1,
    };
  }
  // Cloudflare: list all keys under the namespace, then aggregate.
  if (!acc.accountId || !acc.namespaceId || !acc.token) {
    return Promise.reject({
      message: 'Cloudflare account is not configured',
      code: MessageErrorCode.AccountCheck,
    });
  }
  const { listCloudflareKVKeys } = await import('../cloudflare/api');
  const keys = await listCloudflareKVKeys(acc.accountId, acc.namespaceId, acc.token);
  const perKey: Array<any> = [];
  const total = {
    domainsAdded: 0,
    domainsMerged: 0,
    cookiesAdded: 0,
    cookiesOverridden: 0,
    localStorageMerged: 0,
  };
  let keysMerged = 0;
  for (const key of keys) {
    let content = '';
    try {
      content = await readCloudflareKVByKey(acc.accountId!, acc.namespaceId!, acc.token!, key);
    } catch (e) {
      console.warn('failed to read kv key', key, e);
      continue;
    }
    if (!content) continue;
    let remote: ICookiesMap;
    try {
      remote = await decodeRawContent(content);
    } catch (e) {
      console.warn('failed to decode kv key', key, e);
      continue;
    }
    const plainRemote: ICookiesMap = JSON.parse(JSON.stringify(remote || {}));
    const counts = await cookieStorage.mergeFromRemote(plainRemote);
    perKey.push({ storageKey: key, remote: plainRemote, counts });
    total.domainsAdded += counts.domainsAdded;
    total.domainsMerged += counts.domainsMerged;
    total.cookiesAdded += counts.cookiesAdded;
    total.cookiesOverridden += counts.cookiesOverridden;
    total.localStorageMerged += counts.localStorageMerged;
    keysMerged += 1;
  }
  return { perKey, total, keysScanned: keys.length, keysMerged };
};

/**
 * Push the entire local `cookieStorage` to the currently active cloud storage
 * key (settingsStorage.storageKey) in one shot.
 *
 * This is the symmetric counterpart of `pullAndMergeToLocal`. Useful right
 * before reinstalling or moving to another machine: bundle every tracked
 * site onto the cloud in a single request.
 *
 * Conflict policy: LOCAL WINS (overrides remote per-domain) — because the user
 * explicitly chose to upload everything and is okay with the active storageKey
 * becoming the authoritative snapshot of local.
 */
export const pushAllToActiveStorageKey = async (accountInfo?: AccountInfo): Promise<{
  storageKey: string;
  hosts: number;
  cookies: number;
  localStorageItems: number;
}> => {
  const acc = accountInfo || accountStorage.getSnapshot();
  if (!acc) {
    return Promise.reject({
      message: 'Account info is empty',
      code: MessageErrorCode.AccountCheck,
    });
  }
  const settingsInfo = settingsStorage.getSnapshot();
  const storageKey = settingsInfo?.storageKey;
  if (!storageKey) {
    return Promise.reject({
      message: 'No active storage key configured',
      code: MessageErrorCode.AccountCheck,
    });
  }
  const localSnap = cookieStorage.getSnapshot() || {};
  const domainCookieMap = localSnap.domainCookieMap || {};
  const hosts = Object.keys(domainCookieMap);
  if (hosts.length === 0) {
    return Promise.reject({
      message: 'Local cookieStorage is empty, nothing to push',
      code: MessageErrorCode.AccountCheck,
    });
  }

  const payloads: Array<{
    domain: string;
    cookies: ICookie[];
    localStorageItems: ILocalStorageItem[];
    userAgent?: string;
  }> = hosts.map(host => {
    const entry = domainCookieMap[host] || {};
    return {
      domain: host,
      cookies: (entry.cookies || []) as ICookie[],
      localStorageItems: (entry.localStorageItems || []) as ILocalStorageItem[],
      userAgent: entry.userAgent || '',
    };
  });
  // Read the existing remote first so we don't drop any data; then write with
  // our local cookies merged in (local wins on conflict).
  const oldRemote = await readCookiesMap(acc).catch(() => ({}));
  const [, merged] = await mergeAndWriteMultipleDomainCookies(
    acc as any,
    payloads,
    oldRemote || {},
  );

  let cookieCount = 0;
  let lsCount = 0;
  for (const p of payloads) {
    cookieCount += p.cookies.length;
    lsCount += p.localStorageItems.length;
  }
  return {
    storageKey,
    hosts: hosts.length,
    cookies: cookieCount,
    localStorageItems: lsCount,
  };
};