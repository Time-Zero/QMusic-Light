use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime};

use crate::cache;
use crate::state::AppState;

/// 单次响应最多给出的字节数。
///
/// Chromium 的媒体加载器本来就是一截一截带 Range 取的，一次把它请求的整段
/// 全给出去并没有好处：无损一首三四十 MB，Rust 侧要分配一份、跨 IPC 复制一份、
/// WebView2 再缓冲一份，峰值直接乘三。返回一段合法的短 `Content-Range` 就行，
/// 客户端会顺着末尾继续取（RFC 9110 §14.4 允许 206 只覆盖请求范围的一部分）。
const MAX_CHUNK_BYTES: u64 = 2 * 1024 * 1024;

/// 缓存文件按「质量-mid」命名，同名内容不会再变，可以放心长缓存。
/// 原来写 `no-store`，于是每次 seek 都要重新走一遍协议处理器与磁盘读取。
const CACHE_CONTROL: &str = "private, max-age=604800, immutable";

/// `qmcache://localhost/<file>`：把播放缓存目录里的文件当本地音源回放。
/// 必须实现 Range，否则 `<audio>` 无法拖动进度条。
pub fn respond<R: Runtime>(app: &AppHandle<R>, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let state = app.state::<AppState>();
    let name = request.uri().path().trim_start_matches('/');
    let Some(path) = state.cache.resolve(name) else {
        return not_found();
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return not_found();
    };
    let len = meta.len();
    if len == 0 {
        return not_found();
    }
    let content_type = cache::content_type(&path);

    let requested = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| cache::parse_range(value, len));

    // 没有 Range（直接把这个地址丢进浏览器才会发生）：小文件整段给，
    // 大文件同样只给首块，否则又会回到一次分配整个文件的老路。
    let (start, end, partial) = match requested {
        Some((start, end)) => (start, end.min(start.saturating_add(MAX_CHUNK_BYTES - 1)), true),
        None if len <= MAX_CHUNK_BYTES => (0, len - 1, false),
        None => (0, MAX_CHUNK_BYTES - 1, true),
    };

    let Ok(body) = cache::read_slice(&path, start, end - start + 1) else {
        return not_found();
    };
    build(
        if partial { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK },
        content_type,
        body,
        partial.then_some((start, end)),
        len,
    )
}

fn build(
    status: StatusCode,
    content_type: &'static str,
    body: Vec<u8>,
    range: Option<(u64, u64)>,
    len: u64,
) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, body.len().to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, CACHE_CONTROL);
    if let Some((start, end)) = range {
        builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    builder.body(body).unwrap_or_else(|_| not_found())
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_LENGTH, "0")
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}
