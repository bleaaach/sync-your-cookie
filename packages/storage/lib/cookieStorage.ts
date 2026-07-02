import { ICookie, ICookiesMap, ILocalStorageItem } from '@sync-your-cookie/protobuf';
import { BaseStorage, createStorage, StorageType } from './base';

export interface Cookie extends ICookiesMap {}

type IDomainCookie = NonNullable<ICookiesMap['domainCookieMap']>[string];

const cacheStorageMap = new Map();
const key = 'cookie-storage-key';

// unique key for a single cookie entry: domain (lowercased) + name
const cookieKey = (
  domain: string | null | undefined,
  name: string | null | undefined,
  path: string | null | undefined = '/',
) => {
  // Use a recognizable, non-empty placeholder for null/undefined so that
  // multiple cookies without an explicit domain/name don't collapse into one
  // single bucket (which previously caused data loss during merge).
  const d = (domain == null ? '__no_domain__' : String(domain)).toLowerCase();
  const n = name == null ? '__no_name__' : String(name);
  const p = path || '__no_path__';
  return `${d}\u0000${n}\u0000${p}`;
};

// merge remote domain's cookies into local list, "same name+domain => remote wins"
const mergeCookies = (localCookies: ICookie[] = [], remoteCookies: ICookie[] = []): ICookie[] => {
  const byKey = new Map<string, ICookie>();
  // Preserve original semantics (remote wins on conflict), but include `path`
  // in the key to avoid collapsing cookies that legitimately differ only by path.
  for (const c of localCookies) byKey.set(cookieKey(c.domain, c.name, c.path), c);
  for (const c of remoteCookies) byKey.set(cookieKey(c.domain, c.name, c.path), c); // remote wins
  return Array.from(byKey.values());
};

// merge remote localStorage items into local, "same key => remote wins"
const mergeLocalStorageItems = (
  local: ILocalStorageItem[] = [],
  remote: ILocalStorageItem[] = [],
): ILocalStorageItem[] => {
  const byKey = new Map<string, ILocalStorageItem>();
  for (const it of local) {
    if (it.key != null) byKey.set(it.key, it);
  }
  for (const it of remote) {
    if (it.key != null) byKey.set(it.key, it); // remote wins
  }
  return Array.from(byKey.values());
};

const initStorage = (): BaseStorage<Cookie> => {
  if (cacheStorageMap.has(key)) {
    return cacheStorageMap.get(key);
  }
  const storage: BaseStorage<Cookie> = createStorage<Cookie>(
    key,
    {},
    {
      storageType: StorageType.Local,
      liveUpdate: true,
    },
  );
  cacheStorageMap.set(key, storage);
  return storage;
};

const storage = initStorage();

export const cookieStorage = {
  ...storage,
  reset: async () => {
    await storage.set(() => {
      return {};
    });
  },
  updateItem: async (domain: string, updateCookies: ICookie[], items: ILocalStorageItem[] =[]) => {
    let newVal: Cookie = {};
    await storage.set(currentInfo => {
      const domainCookieMap = currentInfo.domainCookieMap || {};
      currentInfo.createTime = currentInfo.createTime || Date.now();
      currentInfo.updateTime = Date.now();
      domainCookieMap[domain] = {
        ...domainCookieMap[domain],
        cookies: updateCookies,
        localStorageItems: items
      };
      newVal = { ...currentInfo, domainCookieMap };
      return newVal;
    });
    return newVal;
  },
  update: async (updateInfo: Cookie, isInit = false) => {
    let newVal: Cookie = {};
    await storage.set(currentInfo => {
      newVal = isInit ? updateInfo : { ...currentInfo, ...updateInfo };
      return newVal;
    });
    return newVal;
  },
  removeItem: async (domain: string) => {
    let newVal: Cookie = {};
    await storage.set(currentInfo => {
      const domainCookieMap = currentInfo.domainCookieMap || {};
      delete domainCookieMap[domain];
      newVal = { ...currentInfo, domainCookieMap };
      return newVal;
    });
    return newVal;
  },

  removeDomainItem: async (domain: string, name: string) => {
    let newVal: Cookie = {};
    await storage.set(currentInfo => {
      const domainCookieMap = currentInfo.domainCookieMap || {};
      const domainCookies = domainCookieMap[domain] || {};
      const cookies = domainCookies.cookies || [];
      const newCookies = cookies.filter(cookie => cookie.name !== name);
      domainCookieMap[domain] = {
        ...domainCookies,
        cookies: newCookies,
      };
      newVal = { ...currentInfo, domainCookieMap };
      return newVal;
    });
    return newVal;
  },

  // Merge a remote ICookiesMap into local cookieStorage.
  // For each remote domain: merge cookies/localStorageItems by (domain,name) / (key),
  // remote values win on conflict. Remote-only domains are added as-is.
  // Returns counts { domainsAdded, domainsMerged, cookiesAdded, cookiesOverridden, localStorageMerged }.
  mergeFromRemote: async (remote: ICookiesMap | undefined | null): Promise<{
    domainsAdded: number;
    domainsMerged: number;
    cookiesAdded: number;
    cookiesOverridden: number;
    localStorageMerged: number;
  }> => {
    const remoteDomains = remote?.domainCookieMap || {};
    const counts = {
      domainsAdded: 0,
      domainsMerged: 0,
      cookiesAdded: 0,
      cookiesOverridden: 0,
      localStorageMerged: 0,
    };
    const localSnap = storage.getSnapshot() || {};
    const localDomainMap: Record<string, IDomainCookie> = localSnap.domainCookieMap || {};

    await storage.set(currentInfo => {
      const merged: Record<string, IDomainCookie> = { ...(currentInfo.domainCookieMap || {}) };
      for (const [domain, remoteEntry] of Object.entries(remoteDomains)) {
        const remoteCookies: ICookie[] = remoteEntry?.cookies || [];
        const remoteLS: ILocalStorageItem[] = remoteEntry?.localStorageItems || [];
        const existing = merged[domain];
        if (!existing) {
          merged[domain] = {
            ...remoteEntry,
            cookies: [...remoteCookies],
            localStorageItems: [...remoteLS],
            createTime: remoteEntry?.createTime || Date.now(),
            updateTime: Date.now(),
          };
          counts.domainsAdded += 1;
          counts.cookiesAdded += remoteCookies.length;
          counts.localStorageMerged += remoteLS.length;
        } else {
          const localCookies: ICookie[] = existing.cookies || [];
          const localLS: ILocalStorageItem[] = existing.localStorageItems || [];
          const localKeys = new Set(localCookies.map((c: ICookie) => cookieKey(c.domain, c.name, c.path)));
          for (const rc of remoteCookies) {
            if (localKeys.has(cookieKey(rc.domain, rc.name, rc.path))) {
              counts.cookiesOverridden += 1;
            } else {
              counts.cookiesAdded += 1;
            }
          }
          counts.localStorageMerged += remoteLS.length;
          merged[domain] = {
            ...existing,
            cookies: mergeCookies(localCookies, remoteCookies),
            localStorageItems: mergeLocalStorageItems(localLS, remoteLS),
            updateTime: Date.now(),
          };
          counts.domainsMerged += 1;
        }
      }
      return {
        ...currentInfo,
        domainCookieMap: merged,
        updateTime: Date.now(),
      };
    });
    return counts;
  },
};
