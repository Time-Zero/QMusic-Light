use std::sync::{LazyLock, Mutex};

use base64::Engine;
use regex::Regex;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde_json::{json, Map, Value};

use crate::error::{PResult, PlatformError};

/// 与 Node 平台层 / 文档 §6.2 完全一致的 schema。
/// 凭证不进 SQLite：musickey/refresh_token/openid 走 secret 存储。
const SCHEMA: &str = r#"
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
"#;

static ALLOWED_START: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\b").expect("合法 SQL 正则")
});
static FORBIDDEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(ATTACH|DETACH|PRAGMA|VACUUM|DROP|ALTER|CREATE|TRIGGER|LOAD_EXTENSION)\b")
        .expect("禁止关键字正则")
});

pub fn open(path: &std::path::Path) -> PResult<Connection> {
    let connection = Connection::open(path)?;
    connection.execute_batch(SCHEMA)?;
    Ok(connection)
}

fn assert_safe(sql: &str) -> PResult<()> {
    if sql.trim().is_empty() {
        return Err(PlatformError::bad_request("SQL 为空"));
    }
    let mut trimmed = sql.trim();
    if let Some(stripped) = trimmed.strip_suffix(';') {
        trimmed = stripped.trim_end();
    }
    if trimmed.contains(';') {
        return Err(PlatformError::bad_request("只允许单条语句"));
    }
    if !ALLOWED_START.is_match(trimmed) {
        return Err(PlatformError::bad_request("只允许读写数据的 DML 语句"));
    }
    if FORBIDDEN.is_match(trimmed) {
        return Err(PlatformError::bad_request("包含被禁止的关键字"));
    }
    Ok(())
}

fn json_to_sql(value: &Value) -> PResult<SqlValue> {
    match value {
        Value::Null => Ok(SqlValue::Null),
        Value::Bool(value) => Ok(SqlValue::Integer(i64::from(*value))),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                Ok(SqlValue::Integer(integer))
            } else if let Some(float) = number.as_f64() {
                Ok(SqlValue::Real(float))
            } else {
                Err(PlatformError::bad_request("SQL 参数必须是标量"))
            }
        }
        Value::String(text) => Ok(SqlValue::Text(text.clone())),
        _ => Err(PlatformError::bad_request("SQL 参数必须是标量")),
    }
}

fn sql_to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(integer) => json!(integer),
        ValueRef::Real(float) => json!(float),
        ValueRef::Text(bytes) => Value::String(String::from_utf8_lossy(bytes).to_string()),
        ValueRef::Blob(bytes) => {
            Value::String(base64::engine::general_purpose::STANDARD.encode(bytes))
        }
    }
}

pub fn select(connection: &Mutex<Connection>, sql: &str, params: &[Value]) -> PResult<Value> {
    assert_safe(sql)?;
    let values = params
        .iter()
        .map(json_to_sql)
        .collect::<PResult<Vec<_>>>()?;
    let connection = connection
        .lock()
        .map_err(|_| PlatformError::msg("数据库锁异常"))?;

    let mut statement = connection.prepare(sql)?;
    let columns = statement
        .column_names()
        .iter()
        .map(|name| name.to_string())
        .collect::<Vec<_>>();

    let rows = statement
        .query_map(params_from_iter(values), |row| {
            let mut object = Map::with_capacity(columns.len());
            for (index, name) in columns.iter().enumerate() {
                object.insert(name.clone(), sql_to_json(row.get_ref(index)?));
            }
            Ok(Value::Object(object))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Value::Array(rows))
}

pub fn execute(connection: &Mutex<Connection>, sql: &str, params: &[Value]) -> PResult<Value> {
    assert_safe(sql)?;
    let values = params
        .iter()
        .map(json_to_sql)
        .collect::<PResult<Vec<_>>>()?;
    let connection = connection
        .lock()
        .map_err(|_| PlatformError::msg("数据库锁异常"))?;
    let changes = connection.execute(sql, params_from_iter(values))?;
    Ok(json!(changes as i64))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Mutex<Connection> {
        let connection = Connection::open_in_memory().expect("内存库");
        connection.execute_batch(SCHEMA).expect("建表");
        Mutex::new(connection)
    }

    #[test]
    fn select_and_execute() {
        let db = memory();
        let changes = execute(
            &db,
            "INSERT INTO setting (key, value) VALUES (?, ?)",
            &[json!("theme"), json!("dark")],
        )
        .expect("写入");
        assert_eq!(changes, 1);

        let rows = select(
            &db,
            "SELECT value FROM setting WHERE key = ?",
            &[json!("theme")],
        )
        .expect("查询");
        assert_eq!(rows[0]["value"], json!("dark"));
    }

    #[test]
    fn rejects_multi_statement_and_ddl() {
        let db = memory();
        for sql in [
            "SELECT 1; SELECT 2",
            "DROP TABLE song",
            "CREATE TABLE x (id INTEGER)",
            "PRAGMA user_version",
            "ATTACH DATABASE 'x' AS y",
        ] {
            assert!(select(&db, sql, &[]).is_err(), "应拒绝: {sql}");
        }
    }

    #[test]
    fn stats_row_shape() {
        let db = memory();
        let rows = select(&db, "SELECT COUNT(*) AS c FROM song", &[]).expect("统计");
        assert_eq!(rows[0]["c"], 0);
    }
}
