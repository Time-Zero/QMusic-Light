import { DatabaseSync } from 'node:sqlite';
import { dataFile } from './config.mjs';

/**
 * 本地库（文档 §6.2）。凭证不进 SQLite：musickey/refresh_token/openid 走 secret 存储。
 * media_mid / cache_entry 为增量字段；迁移只增不删（文档 §6.4）。
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS account (
  uin            TEXT PRIMARY KEY,
  nickname       TEXT NOT NULL DEFAULT '',
  avatar         TEXT NOT NULL DEFAULT '',
  encrypt_uin    TEXT NOT NULL DEFAULT '',
  vip_level      INTEGER NOT NULL DEFAULT 0,
  key_expires_at INTEGER NOT NULL DEFAULT 0,
  last_login_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS playlist (
  id          INTEGER NOT NULL,
  owner_uin   TEXT    NOT NULL DEFAULT '',
  dirid       INTEGER NOT NULL DEFAULT 0,
  title       TEXT    NOT NULL,
  cover       TEXT    NOT NULL DEFAULT '',
  description TEXT    NOT NULL DEFAULT '',
  song_count  INTEGER NOT NULL DEFAULT 0,
  play_count  INTEGER NOT NULL DEFAULT 0,
  kind        TEXT    NOT NULL DEFAULT 'created',
  synced_at   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, owner_uin)
);

CREATE TABLE IF NOT EXISTS song (
  mid           TEXT PRIMARY KEY,
  song_id       INTEGER NOT NULL DEFAULT 0,
  name          TEXT    NOT NULL,
  album_mid     TEXT    NOT NULL DEFAULT '',
  album_name    TEXT    NOT NULL DEFAULT '',
  singers_json  TEXT    NOT NULL DEFAULT '[]',
  cover         TEXT    NOT NULL DEFAULT '',
  duration      INTEGER NOT NULL DEFAULT 0,
  pay_play      INTEGER NOT NULL DEFAULT 0,
  media_mid     TEXT    NOT NULL DEFAULT '',
  updated_at    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS playlist_track (
  playlist_id INTEGER NOT NULL,
  owner_uin   TEXT    NOT NULL DEFAULT '',
  song_mid    TEXT    NOT NULL,
  position    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, owner_uin, song_mid)
);
CREATE INDEX IF NOT EXISTS idx_track_playlist ON playlist_track(playlist_id, owner_uin, position);

CREATE TABLE IF NOT EXISTS play_history (
  song_mid  TEXT NOT NULL,
  played_at INTEGER NOT NULL,
  PRIMARY KEY (song_mid, played_at)
);
CREATE INDEX IF NOT EXISTS idx_history_time ON play_history(played_at DESC);

CREATE TABLE IF NOT EXISTS daily_recommend (
  day      TEXT NOT NULL,
  song_mid TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (day, song_mid)
);

CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cache_entry (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_expire ON cache_entry(expires_at);
`;

const ALLOWED_START = /^(SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i;
const FORBIDDEN = /\b(ATTACH|DETACH|PRAGMA|VACUUM|DROP|ALTER|CREATE|TRIGGER|LOAD_EXTENSION)\b/i;

export class Db {
  constructor(file = dataFile('qmusic.db')) {
    this.raw = new DatabaseSync(file);
    this.raw.exec(SCHEMA);
  }

  static assertSafe(sql) {
    if (typeof sql !== 'string' || !sql.trim()) throw new Error('SQL 为空');
    if (sql.includes(';') && sql.trim().replace(/;\s*$/, '').includes(';')) {
      throw new Error('只允许单条语句');
    }
    const trimmed = sql.trim().replace(/;\s*$/, '');
    if (!ALLOWED_START.test(trimmed)) throw new Error('只允许读写数据的 DML 语句');
    if (FORBIDDEN.test(trimmed)) throw new Error('包含被禁止的关键字');
  }

  select(sql, params = []) {
    Db.assertSafe(sql);
    return this.raw.prepare(sql).all(...params);
  }

  execute(sql, params = []) {
    Db.assertSafe(sql);
    const result = this.raw.prepare(sql).run(...params);
    return Number(result.changes ?? 0);
  }

  close() {
    try {
      this.raw.close();
    } catch {
      // 忽略
    }
  }
}
