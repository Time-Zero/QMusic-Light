use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::error::{PResult, PlatformError};

/// 单曲缓存上限：异常大的文件直接放弃，避免一次请求撑爆磁盘。
const MAX_TRACK_BYTES: u64 = 200 * 1024 * 1024;
/// 小于该长度的响应视为失败（QQ 音乐在版权受限时会返回极短的错误体）。
const MIN_TRACK_BYTES: u64 = 1024;
/// 淘汰时压到这个比例以下，避免每加一首就触发一轮删除。
const EVICT_TARGET: f64 = 0.9;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub dir: String,
    pub default_dir: String,
    pub used_bytes: u64,
    pub file_count: u64,
}

/// 播放音频的本地缓存：整首落盘，命中后由 `qmcache://` 协议从磁盘回放。
pub struct StreamCache {
    root: RwLock<PathBuf>,
    default_root: PathBuf,
    client: reqwest::Client,
    inflight: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl StreamCache {
    pub fn new(default_root: PathBuf, root: PathBuf) -> Self {
        let _ = fs::create_dir_all(&root);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("初始化缓存下载客户端失败");
        Self {
            root: RwLock::new(root),
            default_root,
            client,
            inflight: Mutex::new(HashMap::new()),
        }
    }

    pub fn dir(&self) -> PathBuf {
        self.root
            .read()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| self.default_root.clone())
    }

    /// 切换目录时立即建目录，创建失败就报错（让设置页当场提示路径不可用）。
    pub fn set_dir(&self, dir: Option<PathBuf>) -> PResult<()> {
        let next = dir.unwrap_or_else(|| self.default_root.clone());
        fs::create_dir_all(&next)?;
        if let Ok(mut guard) = self.root.write() {
            *guard = next;
        }
        Ok(())
    }

    pub fn stats(&self) -> CacheStats {
        let dir = self.dir();
        let (used_bytes, file_count) = dir_usage(&dir);
        CacheStats {
            dir: dir.to_string_lossy().to_string(),
            default_dir: self.default_root.to_string_lossy().to_string(),
            used_bytes,
            file_count,
        }
    }

    /// 命中则刷新访问时间（LRU 依据）并返回路径与体积。
    pub fn get(&self, key: &str, ext: &str) -> Option<(PathBuf, u64)> {
        let name = file_name(key, ext)?;
        let path = self.dir().join(name);
        let meta = fs::metadata(&path).ok()?;
        if !meta.is_file() || meta.len() < MIN_TRACK_BYTES {
            return None;
        }
        touch(&path);
        Some((path, meta.len()))
    }

    pub fn cancel(&self, key: &str, ext: &str) {
        let Some(name) = file_name(key, ext) else {
            return;
        };
        if let Ok(map) = self.inflight.lock() {
            if let Some(flag) = map.get(&name) {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    /// 下载整首并落盘。返回 `None` 表示已取消 / 已有同名任务在跑，调用方回落直链即可。
    pub async fn fetch(
        &self,
        key: &str,
        ext: &str,
        url: &str,
        max_bytes: u64,
    ) -> PResult<Option<(PathBuf, u64)>> {
        let name = file_name(key, ext).ok_or_else(|| PlatformError::bad_request("缓存键不合法"))?;
        ensure_allowed_url(url)?;
        if let Some(hit) = self.get(key, ext) {
            return Ok(Some(hit));
        }

        let dir = self.dir();
        fs::create_dir_all(&dir)?;
        let final_path = dir.join(&name);
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut map = self
                .inflight
                .lock()
                .map_err(|_| PlatformError::msg("缓存任务表锁异常"))?;
            if map.contains_key(&name) {
                return Ok(None);
            }
            map.insert(name.clone(), cancel.clone());
        }

        let result = self
            .download(&final_path, url, &cancel)
            .await
            .inspect_err(|_| remove_quietly(&part_path(&final_path)));

        if let Ok(mut map) = self.inflight.lock() {
            map.remove(&name);
        }

        if !result? {
            return Ok(None);
        }

        touch(&final_path);
        self.enforce_limit(max_bytes);
        // 单曲就可能超过上限的场景：刚下完就被自己挤掉，这时直接告诉调用方没有缓存
        let len = match fs::metadata(&final_path) {
            Ok(meta) if meta.is_file() => meta.len(),
            _ => return Ok(None),
        };
        Ok(Some((final_path, len)))
    }

    async fn download(
        &self,
        final_path: &Path,
        url: &str,
        cancel: &Arc<AtomicBool>,
    ) -> PResult<bool> {
        let part = part_path(final_path);
        let response = self
            .client
            .get(url)
            .header(reqwest::header::USER_AGENT, crate::net::UA)
            .header(reqwest::header::REFERER, "https://y.qq.com/")
            .header(reqwest::header::ACCEPT, "*/*")
            .send()
            .await
            .map_err(|error| PlatformError::msg(format!("缓存下载失败：{error}")))?;

        let status = response.status().as_u16();
        if status != 200 && status != 206 {
            return Err(PlatformError::msg(format!("音源返回 {status}，跳过缓存")));
        }

        let mut sink = BufWriter::new(File::create(&part)?);
        let mut written: u64 = 0;
        let mut stream = response;
        while let Some(chunk) = stream
            .chunk()
            .await
            .map_err(|error| PlatformError::msg(format!("缓存下载中断：{error}")))?
        {
            if cancel.load(Ordering::SeqCst) {
                drop(sink);
                remove_quietly(&part);
                return Ok(false);
            }
            written += chunk.len() as u64;
            if written > MAX_TRACK_BYTES {
                drop(sink);
                remove_quietly(&part);
                return Err(PlatformError::msg("音频体积异常，已放弃缓存"));
            }
            sink.write_all(&chunk)?;
        }
        sink.flush()?;
        drop(sink);

        if written < MIN_TRACK_BYTES {
            remove_quietly(&part);
            return Err(PlatformError::msg("音源返回内容为空，已放弃缓存"));
        }
        if cancel.load(Ordering::SeqCst) {
            remove_quietly(&part);
            return Ok(false);
        }

        if fs::rename(&part, final_path).is_err() {
            fs::copy(&part, final_path)?;
            remove_quietly(&part);
        }
        Ok(true)
    }

    /// 超过上限时按最近使用时间从旧到新删除，直到落到 90% 以下。
    pub fn enforce_limit(&self, max_bytes: u64) {
        let mut entries = collect_files(&self.dir());
        let mut total: u64 = entries.iter().map(|entry| entry.1).sum();
        if total <= max_bytes {
            return;
        }
        let target = (max_bytes as f64 * EVICT_TARGET) as u64;
        entries.sort_by_key(|entry| entry.2);
        for (path, size, _) in entries {
            if total <= target {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(size);
            }
        }
    }

    pub fn clear(&self) {
        for (path, _, _) in collect_files(&self.dir()) {
            remove_quietly(&path);
        }
    }

    /// 协议处理器用：只接受本目录下的文件名，挡掉 ../ 之类的路径穿越。
    pub fn resolve(&self, name: &str) -> Option<PathBuf> {
        let valid = !name.is_empty()
            && !name.contains('/')
            && !name.contains('\\')
            && !name.contains("..")
            && name.len() <= 160;
        if !valid {
            return None;
        }
        let path = self.dir().join(name);
        if path.is_file() {
            Some(path)
        } else {
            None
        }
    }
}

/// 缓存文件的可播放 URL。Windows 下自定义协议走 http://<scheme>.localhost。
pub fn url_for(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    if cfg!(windows) {
        format!("http://qmcache.localhost/{name}")
    } else {
        format!("qmcache://localhost/{name}")
    }
}

pub fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
    {
        "flac" => "audio/flac",
        "m4a" | "aac" | "mp4" => "audio/mp4",
        "wav" => "audio/wav",
        _ => "audio/mpeg",
    }
}

/// 解析单段 Range 请求（Chromium 播放音乐只会发 `bytes=N-` 或 `bytes=N-M`）。
pub fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let spec = header.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (start_raw, end_raw) = first.split_once('-')?;
    if start_raw.is_empty() {
        let suffix: u64 = end_raw.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        return Some((len.saturating_sub(suffix), len - 1));
    }
    let start: u64 = start_raw.parse().ok()?;
    if start >= len {
        return None;
    }
    let end = if end_raw.is_empty() {
        len - 1
    } else {
        end_raw.parse::<u64>().ok()?.min(len - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

fn file_name(key: &str, ext: &str) -> Option<String> {
    let key = sanitize(key);
    if key.is_empty() {
        return None;
    }
    Some(format!("{key}.{}", sanitize_ext(ext)))
}

fn sanitize(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .take(96)
        .collect()
}

fn sanitize_ext(ext: &str) -> String {
    let cleaned: String = ext
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(5)
        .collect();
    if cleaned.is_empty() {
        "mp3".to_string()
    } else {
        cleaned.to_ascii_lowercase()
    }
}

fn part_path(final_path: &Path) -> PathBuf {
    let mut name = final_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    name.push_str(".part");
    final_path.with_file_name(name)
}

fn touch(path: &Path) {
    if let Ok(file) = File::open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

fn remove_quietly(path: &Path) {
    let _ = fs::remove_file(path);
}

fn collect_files(dir: &Path) -> Vec<(PathBuf, u64, SystemTime)> {
    let mut entries = Vec::new();
    let Ok(read) = fs::read_dir(dir) else {
        return entries;
    };
    for item in read.flatten() {
        let path = item.path();
        let Ok(meta) = item.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let accessed = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        entries.push((path, meta.len(), accessed));
    }
    entries
}

fn dir_usage(dir: &Path) -> (u64, u64) {
    let entries = collect_files(dir);
    let used = entries.iter().map(|entry| entry.1).sum();
    (used, entries.len() as u64)
}

/// 只允许下载 QQ 音乐自己的音源域名，避免这份能力被当成任意下载器。
fn ensure_allowed_url(url: &str) -> PResult<()> {
    let parsed = url::Url::parse(url).map_err(|_| PlatformError::bad_request("音源地址不合法"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(PlatformError::bad_request("音源地址必须是 http(s)"));
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if host.ends_with(".qq.com") || host == "qq.com" {
        Ok(())
    } else {
        Err(PlatformError::forbidden("只缓存 QQ 音乐域名下的音源"))
    }
}

/// 读文件的一段，供协议处理器拼 200 / 206 响应。
pub fn read_slice(path: &Path, start: u64, len: u64) -> PResult<Vec<u8>> {
    use std::io::{Seek, SeekFrom};
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut buffer = vec![0u8; len as usize];
    file.read_exact(&mut buffer)?;
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_range_headers() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=-20", 100), Some((80, 99)));
        assert_eq!(parse_range("bytes=90-200", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=abc", 100), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
        assert_eq!(parse_range("items=0-", 100), None);
    }

    #[test]
    fn sanitizes_keys_and_extensions() {
        assert_eq!(file_name("320-C400abcDEF", "mp3").as_deref(), Some("320-C400abcDEF.mp3"));
        assert_eq!(file_name("../evil", "flac").as_deref(), Some("evil.flac"));
        assert_eq!(file_name("", "mp3"), None);
        assert_eq!(file_name("key", "MP3").as_deref(), Some("key.mp3"));
        assert_eq!(file_name("key", "").as_deref(), Some("key.mp3"));
        // 扩展名里的路径分隔符与点统统被吃掉，最终文件名不会跳出缓存目录
        assert_eq!(sanitize_ext("m/../../etc"), "metc");
        assert!(!file_name("key", "../../etc").unwrap().contains('/'));
    }

    #[test]
    fn rejects_foreign_hosts() {
        assert!(ensure_allowed_url("https://isure.stream.qqmusic.qq.com/a.mp3").is_ok());
        assert!(ensure_allowed_url("https://example.com/a.mp3").is_err());
        assert!(ensure_allowed_url("file:///c:/a.mp3").is_err());
    }

    #[test]
    fn evicts_oldest_files_when_over_limit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cache = StreamCache::new(dir.path().to_path_buf(), dir.path().to_path_buf());
        for (name, size) in [("a.mp3", 4096usize), ("b.mp3", 4096), ("c.mp3", 4096)] {
            fs::write(dir.path().join(name), vec![7u8; size]).expect("write");
        }
        // 只有两首的容量，应至少删掉一首
        cache.enforce_limit(8 * 1024);
        let left = collect_files(dir.path()).len();
        assert!(left < 3, "expected eviction, got {left} files");
    }

    #[test]
    fn reports_usage_and_hits() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cache = StreamCache::new(dir.path().to_path_buf(), dir.path().to_path_buf());
        fs::write(dir.path().join("320-mid.mp3"), vec![1u8; 4096]).expect("write");
        let stats = cache.stats();
        assert_eq!(stats.file_count, 1);
        assert_eq!(stats.used_bytes, 4096);
        assert!(cache.get("320-mid", "mp3").is_some());
        assert!(cache.get("320-missing", "mp3").is_none());
        assert!(cache.resolve("320-mid.mp3").is_some());
        assert!(cache.resolve("../qmusic.db").is_none());
    }
}
