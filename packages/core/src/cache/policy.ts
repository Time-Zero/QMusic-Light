/** 分级 TTL 缓存策略（文档 §6.3） */
export const TTL = {
  qr: 2 * 60 * 1000,
  myPlaylists: 10 * 60 * 1000,
  playlistDetail: 10 * 60 * 1000,
  songDetail: 30 * 24 * 60 * 60 * 1000,
  lyric: 30 * 24 * 60 * 60 * 1000,
  stream: 20 * 60 * 1000,
  feed: 30 * 60 * 1000,
  square: 30 * 60 * 1000,
  search: 5 * 60 * 1000,
} as const;

export function endOfDay(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

export interface CacheStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs: number): void;
  delete(key: string): void;
  clear(): void;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/** 内存缓存（单测与进程内热点数据） */
export function createMemoryCache(now: () => number = Date.now): CacheStore {
  const map = new Map<string, Entry<unknown>>();
  return {
    get<T>(key: string) {
      const hit = map.get(key) as Entry<T> | undefined;
      if (!hit) return undefined;
      if (hit.expiresAt <= now()) {
        map.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value, ttlMs) {
      map.set(key, { value, expiresAt: now() + ttlMs });
    },
    delete(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
  };
}

/** TanStack Query 的 staleTime 直接复用同一张表（文档 §6.3） */
export const STALE_TIME = {
  playlist: TTL.playlistDetail,
  feed: TTL.feed,
  song: TTL.songDetail,
  lyric: TTL.lyric,
  search: TTL.search,
} as const;
