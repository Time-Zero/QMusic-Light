use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::auth;
use crate::cache;
use crate::db;
use crate::error::{PResult, PlatformError};
use crate::lyric;
use crate::picker;
use crate::qq_api;
use crate::state::AppState;
use crate::tray;

/// 单一 IPC 命令，内部按文档 §5.3 的点号命令名分发。
/// 这样前端在 Tauri 与 Node 平台层之间无需改动命令面。
#[tauri::command]
pub async fn ipc(
    app: AppHandle,
    state: State<'_, AppState>,
    command: String,
    args: Option<Value>,
) -> Result<Value, String> {
    let args = args.unwrap_or_else(|| json!({}));
    dispatch(&app, state.inner(), &command, &args)
        .await
        .map_err(|error| error.message)
}

async fn dispatch(app: &AppHandle, state: &AppState, command: &str, args: &Value) -> PResult<Value> {
    match command {
        "auth.qr_start" => auth::qr_start(state).await,
        "auth.qr_poll" => auth::qr_poll(state, args).await,
        "auth.restore" => Ok(auth::restore(state).await),
        "auth.logout" => {
            auth::logout(state).await;
            Ok(json!({}))
        }
        "api.call" => {
            let credentials = state.credentials();
            qq_api::api_call(&state.http, credentials.as_ref(), &state.guid, args).await
        }
        "api.legacy" => {
            let credentials = state.credentials();
            qq_api::legacy_get(&state.http, credentials.as_ref(), &state.guid, args).await
        }
        "db.select" => {
            let (sql, params) = db_args(args)?;
            db::select(&state.db, &sql, &params)
        }
        "db.execute" => {
            let (sql, params) = db_args(args)?;
            db::execute(&state.db, &sql, &params)
        }
        "sys.info" => Ok(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "webview": tauri::webview_version().unwrap_or_else(|_| "WebView2".to_string()),
            "platform": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
            "runtime": "tauri",
        })),
        "health" => Ok(json!({
            "ok": true,
            "loggedIn": state.credentials().is_some(),
            "guid": state.guid,
        })),
        "app.settings" => Ok(settings_json(state)),
        "app.prefs_update" => {
            // 先按补丁算出新偏好并验证副作用（缓存目录能否创建），再落盘
            let next = state.prefs.preview(args)?;
            state
                .cache
                .set_dir(next.cache_dir.as_ref().map(PathBuf::from))?;
            state.prefs.commit(next.clone());
            state.cache.enforce_limit(next.cache_max_bytes);
            Ok(settings_json(state))
        }
        "app.pick_dir" => pick_dir(app).await,
        "app.tray_sync" => {
            let title = args.get("title").and_then(Value::as_str).unwrap_or_default();
            let playing = args.get("playing").and_then(Value::as_bool).unwrap_or(false);
            tray::sync_tooltip(app, title, playing);
            Ok(json!({}))
        }
        "app.show" => {
            tray::show_main(app);
            Ok(json!({}))
        }
        "app.quit" => {
            app.exit(0);
            Ok(json!({}))
        }
        // 桌面歌词：开关 / 快照补读 / 增量同步 / 浮窗上的播放控制 / 位置记忆
        "lyric.set_enabled" => {
            let enabled = args.get("enabled").and_then(Value::as_bool).unwrap_or(false);
            lyric::set_enabled(app, state, enabled)
        }
        "lyric.snapshot" => Ok(state.lyric.snapshot()),
        "lyric.sync" => Ok(lyric::sync(app, state, args)),
        "lyric.action" => {
            let action = arg_str(args, "action")?;
            lyric::dispatch_action(app, &action);
            Ok(json!({}))
        }
        "lyric.persist_pos" => lyric::persist_pos(state, args),
        "cache.get" => {
            let key = arg_str(args, "key")?;
            let ext = arg_str(args, "ext")?;
            Ok(match state.cache.get(&key, &ext) {
                Some((path, bytes)) => json!({ "url": cache::url_for(&path), "bytes": bytes }),
                None => Value::Null,
            })
        }
        "cache.prefetch" => {
            let prefs = state.prefs.get();
            if !prefs.stream_cache {
                return Ok(Value::Null);
            }
            let key = arg_str(args, "key")?;
            let ext = arg_str(args, "ext")?;
            let url = arg_str(args, "url")?;
            match state
                .cache
                .fetch(&key, &ext, &url, prefs.cache_max_bytes)
                .await?
            {
                Some((path, bytes)) => {
                    Ok(json!({ "url": cache::url_for(&path), "bytes": bytes }))
                }
                None => Ok(Value::Null),
            }
        }
        "cache.cancel" => {
            let key = arg_str(args, "key")?;
            let ext = arg_str(args, "ext")?;
            state.cache.cancel(&key, &ext);
            Ok(json!({}))
        }
        "cache.stats" => Ok(stats_json(state)),
        "cache.clear" => {
            state.cache.clear();
            Ok(stats_json(state))
        }
        other => Err(PlatformError::new(format!("未知的 IPC 命令：{other}"), 404)),
    }
}

fn settings_json(state: &AppState) -> Value {
    let prefs = state.prefs.get();
    let stats = state.cache.stats();
    json!({
        "closeAction": prefs.close_action,
        "minimizeToTray": prefs.minimize_to_tray,
        "streamCache": prefs.stream_cache,
        "cacheDir": stats.dir,
        "defaultCacheDir": stats.default_dir,
        "cacheMaxBytes": prefs.cache_max_bytes,
        "cacheUsedBytes": stats.used_bytes,
        "cacheFileCount": stats.file_count,
    })
}

fn stats_json(state: &AppState) -> Value {
    let stats = state.cache.stats();
    json!({
        "dir": stats.dir,
        "defaultDir": stats.default_dir,
        "usedBytes": stats.used_bytes,
        "fileCount": stats.file_count,
    })
}

/// 弹原生文件夹选择器：模态循环必须跑在界面线程，这里用一次握手把结果取回。
async fn pick_dir(app: &AppHandle) -> PResult<Value> {
    let owner = main_hwnd(app);
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(picker::pick_folder(owner));
    })
    .map_err(|error| PlatformError::msg(format!("无法在界面线程打开选择器：{error}")))?;

    let picked = rx
        .await
        .map_err(|_| PlatformError::msg("选择器未返回结果"))??;
    Ok(json!({ "path": picked }))
}

#[cfg(windows)]
fn main_hwnd(app: &AppHandle) -> Option<isize> {
    app.get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
        .map(|hwnd| hwnd.0 as isize)
}

#[cfg(not(windows))]
fn main_hwnd(_app: &AppHandle) -> Option<isize> {
    None
}

fn arg_str(args: &Value, name: &str) -> PResult<String> {
    args.get(name)
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| PlatformError::bad_request(format!("缺少 {name}")))
}

fn db_args(args: &Value) -> PResult<(String, Vec<Value>)> {
    let sql = args
        .get("sql")
        .and_then(Value::as_str)
        .ok_or_else(|| PlatformError::bad_request("缺少 sql"))?
        .to_string();
    let params = match args.get("params") {
        Some(Value::Array(items)) => items.clone(),
        None | Some(Value::Null) => Vec::new(),
        _ => return Err(PlatformError::bad_request("params 必须是数组")),
    };
    Ok((sql, params))
}
