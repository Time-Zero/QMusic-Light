use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use rusqlite::Connection;
use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::cache::StreamCache;
use crate::db;
use crate::error::{PResult, PlatformError};
use crate::lyric;
use crate::models::{account_from_credentials, Account, Credentials};
use crate::net::Net;
use crate::prefs::PrefStore;
use crate::secret::SecretStore;
use crate::snapshot::Snapshot;
use crate::taskbar;

pub struct QrSession {
    pub id: String,
    pub net: Net,
    pub qrsig: String,
    /// xlogin 下发的 pt_login_sig，ptqrlogin 必须带上
    pub login_sig: String,
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
    /// 平台侧偏好（关闭行为、缓存目录与上限），启动时就要可用，所以落在 prefs.json
    pub prefs: PrefStore,
    /// 整首音频缓存
    pub cache: StreamCache,
    /// 桌面歌词浮窗的最新快照（主窗口推增量，歌词窗口按需补读）
    pub lyric: Snapshot,
    /// 任务栏面板的最新快照（同上，但只装封面与播放态）
    pub taskbar: Snapshot,
    pub secret: SecretStore,
    pub credentials: RwLock<Option<Credentials>>,
    pub account: RwLock<Option<Account>>,
    pub qr_sessions: AsyncMutex<HashMap<String, Arc<AsyncMutex<QrSession>>>>,
    pub restore_cache: Mutex<Option<Value>>,
    pub restore_lock: AsyncMutex<()>,
    /// 托盘是否可用：托盘建不起来就绝不能把窗口藏起来（否则用户再也叫不回来）
    tray_ready: AtomicBool,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> PResult<Self> {
        fs::create_dir_all(&data_dir)?;
        let guid = load_guid(&data_dir)?;
        let connection = db::open(&data_dir.join("qmusic.db"))?;
        let secret = SecretStore::new(&data_dir);
        let credentials = secret.load();
        let account = credentials.as_ref().map(account_from_credentials);

        let prefs = PrefStore::load(&data_dir);
        let default_cache_dir = data_dir.join("stream-cache");
        let cache_dir = prefs
            .get()
            .cache_dir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| default_cache_dir.clone());
        let cache = StreamCache::new(default_cache_dir, cache_dir);

        Ok(Self {
            guid,
            http: Net::new(),
            db: Mutex::new(connection),
            prefs,
            cache,
            lyric: Snapshot::new(lyric::empty_snapshot()),
            taskbar: Snapshot::new(taskbar::empty_snapshot()),
            secret,
            credentials: RwLock::new(credentials),
            account: RwLock::new(account),
            qr_sessions: AsyncMutex::new(HashMap::new()),
            restore_cache: Mutex::new(None),
            restore_lock: AsyncMutex::new(()),
            tray_ready: AtomicBool::new(false),
        })
    }

    pub fn set_tray_ready(&self, value: bool) {
        self.tray_ready.store(value, Ordering::SeqCst);
    }

    pub fn tray_ready(&self) -> bool {
        self.tray_ready.load(Ordering::SeqCst)
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
