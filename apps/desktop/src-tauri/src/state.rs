use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use rusqlite::Connection;
use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::db;
use crate::error::{PResult, PlatformError};
use crate::models::{account_from_credentials, Account, Credentials};
use crate::net::Net;
use crate::secret::SecretStore;

pub struct QrSession {
    pub id: String,
    pub net: Net,
    pub qrsig: String,
    pub image_data_url: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub status: String,
    pub message: String,
    pub account: Option<Account>,
    pub credentials: Option<Credentials>,
}

pub struct AppState {
    pub guid: String,
    pub http: Net,
    pub db: Mutex<Connection>,
    pub secret: SecretStore,
    pub credentials: RwLock<Option<Credentials>>,
    pub account: RwLock<Option<Account>>,
    pub qr_sessions: AsyncMutex<HashMap<String, Arc<AsyncMutex<QrSession>>>>,
    pub restore_cache: Mutex<Option<Value>>,
    pub restore_lock: AsyncMutex<()>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> PResult<Self> {
        fs::create_dir_all(&data_dir)?;
        let guid = load_guid(&data_dir)?;
        let connection = db::open(&data_dir.join("qmusic.db"))?;
        let secret = SecretStore::new(&data_dir);
        let credentials = secret.load();
        let account = credentials.as_ref().map(account_from_credentials);

        Ok(Self {
            guid,
            http: Net::new(),
            db: Mutex::new(connection),
            secret,
            credentials: RwLock::new(credentials),
            account: RwLock::new(account),
            qr_sessions: AsyncMutex::new(HashMap::new()),
            restore_cache: Mutex::new(None),
            restore_lock: AsyncMutex::new(()),
        })
    }

    pub fn credentials(&self) -> Option<Credentials> {
        self.credentials.read().ok().and_then(|guard| guard.clone())
    }

    pub fn account(&self) -> Option<Account> {
        self.account.read().ok().and_then(|guard| guard.clone())
    }

    pub fn set_session(&self, credentials: Option<Credentials>, account: Option<Account>) {
        if let Ok(mut guard) = self.credentials.write() {
            *guard = credentials;
        }
        if let Ok(mut guard) = self.account.write() {
            *guard = account;
        }
        if let Ok(mut cache) = self.restore_cache.lock() {
            *cache = None;
        }
    }
}

fn load_guid(data_dir: &PathBuf) -> PResult<String> {
    let file = data_dir.join("guid");
    if let Ok(existing) = fs::read_to_string(&file) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let guid = Uuid::new_v4().to_string();
    fs::write(&file, &guid)?;
    Ok(guid)
}

pub fn persist_account(state: &AppState, account: &Account) -> PResult<()> {
    let connection = state
        .db
        .lock()
        .map_err(|_| PlatformError::msg("数据库锁异常"))?;
    connection.execute(
        "INSERT INTO account (uin, nickname, avatar, encrypt_uin, vip_level, key_expires_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uin) DO UPDATE SET nickname=excluded.nickname, avatar=excluded.avatar,
           encrypt_uin=excluded.encrypt_uin, vip_level=excluded.vip_level,
           key_expires_at=excluded.key_expires_at, last_login_at=excluded.last_login_at",
        rusqlite::params![
            &account.uin,
            &account.nickname,
            &account.avatar,
            &account.encrypt_uin,
            account.vip_level,
            account.key_expires_at,
            crate::models::now_ms(),
        ],
    )?;
    Ok(())
}
