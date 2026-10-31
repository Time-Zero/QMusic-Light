use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{PResult, PlatformError};

pub const MIN_CACHE_BYTES: u64 = 128 * 1024 * 1024;
pub const MAX_CACHE_BYTES: u64 = 64 * 1024 * 1024 * 1024;
pub const DEFAULT_CACHE_BYTES: u64 = 1024 * 1024 * 1024;

/// 平台侧偏好：窗口关闭行为（启动即需要，因此不能只放在前端 localStorage）与播放缓存配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    /// tray = 收起窗口继续后台播放；quit = 直接退出
    #[serde(default = "default_close_action")]
    pub close_action: String,
    #[serde(default = "default_true")]
    pub minimize_to_tray: bool,
    #[serde(default = "default_true")]
    pub stream_cache: bool,
    #[serde(default)]
    pub cache_dir: Option<String>,
    #[serde(default = "default_cache_bytes")]
    pub cache_max_bytes: u64,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            close_action: default_close_action(),
            minimize_to_tray: true,
            stream_cache: true,
            cache_dir: None,
            cache_max_bytes: DEFAULT_CACHE_BYTES,
        }
    }
}

fn default_close_action() -> String {
    "tray".to_string()
}

fn default_true() -> bool {
    true
}

fn default_cache_bytes() -> u64 {
    DEFAULT_CACHE_BYTES
}

impl Prefs {
    /// 把外部输入收敛到合法区间：未知的关闭行为回到托盘，上限落在 [128MB, 64GB]。
    fn normalized(mut self) -> Self {
        if self.close_action != "tray" && self.close_action != "quit" {
            self.close_action = default_close_action();
        }
        self.cache_max_bytes = self
            .cache_max_bytes
            .clamp(MIN_CACHE_BYTES, MAX_CACHE_BYTES);
        self.cache_dir = self.cache_dir.and_then(|dir| {
            let trimmed = dir.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        });
        self
    }
}

/// prefs.json 的读写封装：读多写少，整体替换即可。
pub struct PrefStore {
    path: PathBuf,
    value: RwLock<Prefs>,
}

impl PrefStore {
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join("prefs.json");
        let value = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Prefs>(&text).ok())
            .unwrap_or_default()
            .normalized();
        Self {
            path,
            value: RwLock::new(value),
        }
    }

    pub fn get(&self) -> Prefs {
        self.value
            .read()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    /// 合并补丁但不落盘：调用方先验证副作用（例如缓存目录能否创建），成功后再 commit。
    pub fn preview(&self, patch: &Value) -> PResult<Prefs> {
        let base = serde_json::to_value(self.get())
            .map_err(|error| PlatformError::msg(format!("偏好序列化失败：{error}")))?;
        let mut merged = base;
        shallow_merge(&mut merged, patch);
        let next: Prefs = serde_json::from_value(merged)
            .map_err(|_| PlatformError::bad_request("偏好字段类型不正确"))?;
        Ok(next.normalized())
    }

    pub fn commit(&self, value: Prefs) {
        if let Ok(mut guard) = self.value.write() {
            *guard = value.clone();
        }
        if let Ok(text) = serde_json::to_string_pretty(&value) {
            let _ = fs::write(&self.path, text);
        }
    }

    #[cfg(test)]
    pub fn update(&self, patch: &Value) -> PResult<Prefs> {
        let next = self.preview(patch)?;
        self.commit(next.clone());
        Ok(next)
    }
}

fn shallow_merge(base: &mut Value, patch: &Value) {
    if let (Value::Object(base_map), Value::Object(patch_map)) = (base, patch) {
        for (key, value) in patch_map {
            base_map.insert(key.clone(), value.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_out_of_range_values() {
        let prefs = Prefs {
            close_action: "explode".into(),
            cache_max_bytes: 1,
            cache_dir: Some("   ".into()),
            ..Default::default()
        }
        .normalized();
        assert_eq!(prefs.close_action, "tray");
        assert_eq!(prefs.cache_max_bytes, MIN_CACHE_BYTES);
        assert!(prefs.cache_dir.is_none());
    }

    #[test]
    fn merges_patch_without_touching_other_fields() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = PrefStore::load(dir.path());
        let next = store
            .update(&json!({ "closeAction": "quit", "streamCache": false }))
            .expect("update");
        assert_eq!(next.close_action, "quit");
        assert!(!next.stream_cache);
        assert_eq!(store.get().close_action, "quit");

        let reloaded = PrefStore::load(dir.path());
        assert_eq!(reloaded.get().close_action, "quit");
        assert!(!reloaded.get().stream_cache);
    }

    #[test]
    fn rejects_bad_types() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = PrefStore::load(dir.path());
        assert!(store.update(&json!({ "cacheMaxBytes": "huge" })).is_err());
    }
}
