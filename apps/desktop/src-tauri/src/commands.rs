use serde_json::{json, Value};
use tauri::State;

use crate::auth;
use crate::db;
use crate::error::{PResult, PlatformError};
use crate::qq_api;
use crate::state::AppState;

/// 单一 IPC 命令，内部按文档 §5.3 的点号命令名分发。
/// 这样前端在 Tauri 与 Node 平台层之间无需改动命令面。
#[tauri::command]
pub async fn ipc(
    state: State<'_, AppState>,
    command: String,
    args: Option<Value>,
) -> Result<Value, String> {
    let args = args.unwrap_or_else(|| json!({}));
    dispatch(state.inner(), &command, &args)
        .await
        .map_err(|error| error.message)
}

async fn dispatch(state: &AppState, command: &str, args: &Value) -> PResult<Value> {
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
        other => Err(PlatformError::new(format!("未知的 IPC 命令：{other}"), 404)),
    }
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
