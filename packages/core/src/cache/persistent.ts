import type { DbClient } from '../storage/db';
import type { CacheStore } from './policy';

interface Entry {
  value: unknown;
  expiresAt: number;
}

/**
 * 持久化缓存：写穿到 SQLite（文档 §6.3 的 30 天级缓存）。
 * 启动时 hydrate 一次，之后读写仍在内存完成。
 */
export class PersistentCache implements CacheStore {
  private readonly mem = new Map<string, Entry>();

  constructor(private readonly db: DbClient) {}

  async hydrate(): Promise<void> {
    try {
      const rows = await this.db.select(
        'SELECT key, value, expires_at FROM cache_entry WHERE expires_at > ?',
        [Date.now()],
      );
      for (const row of rows) {
        const key = typeof row.key === 'string' ? row.key : '';
        const value = typeof row.value === 'string' ? row.value : '';
        const expiresAt = typeof row.expires_at === 'number' ? row.expires_at : 0;
        if (!key || !value) continue;
        try {
          this.mem.set(key, { value: JSON.parse(value), expiresAt });
        } catch {
          // 损坏的缓存直接丢弃，不算错误
        }
      }
    } catch {
      // 数据库不可用时退化为纯内存缓存
    }
  }

  get<T>(key: string): T | undefined {
    const hit = this.mem.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.mem.delete(key);
      void this.db.execute('DELETE FROM cache_entry WHERE key = ?', [key]).catch(() => undefined);
      return undefined;
    }
    return hit.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    const expiresAt = Date.now() + ttlMs;
    this.mem.set(key, { value, expiresAt });
    void this.db
      .execute(
        `INSERT INTO cache_entry (key, value, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at`,
        [key, JSON.stringify(value), expiresAt],
      )
      .catch(() => undefined);
  }

  delete(key: string): void {
    this.mem.delete(key);
    void this.db.execute('DELETE FROM cache_entry WHERE key = ?', [key]).catch(() => undefined);
  }

  deletePrefix(prefix: string): void {
    for (const key of this.mem.keys()) {
      if (key.startsWith(prefix)) this.mem.delete(key);
    }
    void this.db
      .execute('DELETE FROM cache_entry WHERE key LIKE ?', [`${prefix}%`])
      .catch(() => undefined);
  }

  clear(): void {
    this.mem.clear();
    void this.db.execute('DELETE FROM cache_entry').catch(() => undefined);
  }
}
