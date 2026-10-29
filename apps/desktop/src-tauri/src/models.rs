use serde::{Deserialize, Serialize};

/// 凭证只在平台层流转，永不通过 IPC 返回给渲染层（文档 §5.3）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    #[serde(default)]
    pub musicid: String,
    #[serde(default)]
    pub musickey: String,
    #[serde(default)]
    pub refresh_key: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub openid: String,
    #[serde(default)]
    pub encrypt_uin: String,
    #[serde(default)]
    pub key_expires_in: i64,
    #[serde(default)]
    pub musickey_create_time: i64,
    #[serde(default)]
    pub key_expires_at: i64,
    #[serde(default)]
    pub saved_at: i64,
    #[serde(default)]
    pub nickname: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub vip_level: i64,
    #[serde(default)]
    pub vip_label: String,
}

impl Credentials {
    pub fn is_valid(&self) -> bool {
        !self.musickey.is_empty()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub uin: String,
    pub nickname: String,
    pub avatar: String,
    pub encrypt_uin: String,
    pub vip_level: i64,
    pub key_expires_at: i64,
    #[serde(default)]
    pub vip_label: String,
}

#[derive(Debug, Clone, Default)]
pub struct Profile {
    pub nickname: String,
    pub avatar: String,
    pub encrypt_uin: String,
    pub vip_level: i64,
    pub vip_label: String,
}

pub fn account_from_credentials(credentials: &Credentials) -> Account {
    let uin = credentials.musicid.clone();
    Account {
        nickname: if credentials.nickname.is_empty() {
            format!("QQ {uin}")
        } else {
            credentials.nickname.clone()
        },
        avatar: credentials.avatar.clone(),
        encrypt_uin: credentials.encrypt_uin.clone(),
        vip_level: credentials.vip_level,
        key_expires_at: credentials.key_expires_at,
        vip_label: credentials.vip_label.clone(),
        uin,
    }
}

/// 启动时若距过期 < 24h 则刷新（文档 §3.3）。
pub fn should_refresh(credentials: &Credentials) -> bool {
    let expires_at = credentials.key_expires_at;
    if expires_at == 0 {
        return false;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    now > expires_at - 24 * 60 * 60 * 1000
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub fn now_secs() -> i64 {
    now_ms() / 1000
}
