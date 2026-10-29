use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{PResult, PlatformError};
use crate::models::Credentials;

const SERVICE: &str = "qmusic-lite";
const USER: &str = "credentials";

/// 凭证存储：优先系统钥匙串（Windows Credential Manager），
/// 失败时退化为数据目录下的 0600 私有文件；永不写日志（文档 §6.2 / §9.1）。
#[derive(Debug, Clone)]
pub struct SecretStore {
    dir: PathBuf,
}

impl SecretStore {
    pub fn new(dir: impl AsRef<Path>) -> Self {
        Self {
            dir: dir.as_ref().to_path_buf(),
        }
    }

    fn file(&self) -> PathBuf {
        self.dir.join("credentials.json")
    }

    pub fn load(&self) -> Option<Credentials> {
        if let Ok(entry) = keyring::Entry::new(SERVICE, USER) {
            if let Ok(secret) = entry.get_password() {
                if let Ok(credentials) = serde_json::from_str::<Credentials>(&secret) {
                    if credentials.is_valid() {
                        return Some(credentials);
                    }
                }
            }
        }

        let raw = fs::read_to_string(self.file()).ok()?;
        let credentials = serde_json::from_str::<Credentials>(&raw).ok()?;
        credentials.is_valid().then_some(credentials)
    }

    pub fn save(&self, credentials: &Credentials) -> PResult<()> {
        let json = serde_json::to_string_pretty(credentials)
            .map_err(|error| PlatformError::msg(format!("序列化凭证失败：{error}")))?;

        if let Ok(entry) = keyring::Entry::new(SERVICE, USER) {
            let _ = entry.set_password(&json);
        }

        let file = self.file();
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)?;
        }
        write_private(&file, &json)?;
        Ok(())
    }

    pub fn clear(&self) {
        if let Ok(entry) = keyring::Entry::new(SERVICE, USER) {
            let _ = entry.delete_credential();
        }
        let _ = fs::remove_file(self.file());
    }
}

#[cfg(unix)]
fn write_private(path: &Path, contents: &str) -> PResult<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents.as_bytes())?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private(path: &Path, contents: &str) -> PResult<()> {
    fs::write(path, contents)?;
    Ok(())
}
