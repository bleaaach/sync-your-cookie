import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';

export interface WriteResponse {
  success: boolean;
  errors: {
    code: number;
    message: string;
  }[];
}

/**
 *
 * @param value specify the value to write
 * @param accountId cloudflare account id
 * @param namespaceId cloudflare namespace id
 * @param token api token
 * @returns promise<res>
 */
export const writeCloudflareKV = async (value: string, accountId: string, namespaceId: string, token: string) => {
  const storageKey = settingsStorage.getSnapshot()?.storageKey;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${storageKey}`;
  // const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/bulk`;
  // const payload = [
  //   {
  //     key: DEFAULT_KEY,
  //     metadata: JSON.stringify({
  //       someMetadataKey: value,
  //     }),
  //     value: value,
  //   },
  // ];
  const options = {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: value,
  };
  return fetch(url, options).then(res => res.json());
};

/**
 *
 * @param accountId cloudflare account id
 * @param namespaceId cloudflare namespace id
 * @param token api token
 * @returns Promise<res>
 */
export const readCloudflareKV = async (accountId: string, namespaceId: string, token: string) => {
  const storageKey = settingsStorage.getSnapshot()?.storageKey;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${storageKey}`;
  const options = {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  return fetch(url, options).then(async res => {
    if (res.status === 404) {
      return '';
    }
    if (res.status === 200) {
      const text = await res.text();
      return text.trim();
    } else {
      return Promise.reject(await res.json());
    }
  });
};

export const verifyCloudflareAccountToken = async (accountId: string, token: string) => {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`;
  const options = {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  return fetch(url, options).then(async res => {
    if (res.status === 200) {
      return res.json();
    } else {
      return Promise.reject(await res.json());
    }
  });
};

export const verifyCloudflareToken = async (accountId: string, token: string) => {
  const url = `https://api.cloudflare.com/client/v4/user/tokens/verify`;
  const options = {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  return fetch(url, options).then(async res => {
    if (res.status === 200) {
      return res.json();
    } else {
      return verifyCloudflareAccountToken(accountId, token);
    }
  });
};

/**
 * Cloudflare KV supports listing up to ~1000 keys per page via cursor.
 * https://developers.cloudflare.com/api/operations/storage-kv-namespaces-list-keys
 */
export interface KVKeyInfo {
  name: string;
  expiration?: number;
  metadata?: any;
}

export const listCloudflareKVKeys = async (
  accountId: string,
  namespaceId: string,
  token: string,
  prefix = '',
): Promise<string[]> => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams();
    if (prefix) params.set('prefix', prefix);
    if (cursor) params.set('cursor', cursor);
    params.set('limit', '1000');
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/keys?${params}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
      return Promise.reject(json);
    }
    for (const item of json.result as KVKeyInfo[]) {
      if (item?.name) keys.push(item.name);
    }
    cursor = json.result_info?.cursor || undefined;
  } while (cursor);
  return keys;
};

/**
 * Read a specific KV key by name (bypassing settingsStorage.storageKey).
 */
export const readCloudflareKVByKey = async (
  accountId: string,
  namespaceId: string,
  token: string,
  storageKey: string,
): Promise<string> => {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(storageKey)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (res.status === 404) return '';
  if (res.status === 200) {
    return (await res.text()).trim();
  }
  return Promise.reject(await res.json());
};
