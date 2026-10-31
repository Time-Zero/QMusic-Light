use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime};

use crate::cache;
use crate::state::AppState;

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
    let content_type = cache::content_type(&path);

    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    if let Some((start, end)) = range
        .as_deref()
        .and_then(|value| cache::parse_range(value, len))
    {
        let Ok(body) = cache::read_slice(&path, start, end - start + 1) else {
            return not_found();
        };
        return build(StatusCode::PARTIAL_CONTENT, content_type, body, Some((start, end)), len);
    }

    let Ok(body) = cache::read_slice(&path, 0, len) else {
        return not_found();
    };
    build(StatusCode::OK, content_type, body, None, len)
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
        .header(header::CACHE_CONTROL, "no-store");
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
