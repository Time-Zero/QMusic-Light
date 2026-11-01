//! 桌面浮动歌词窗口。
//!
//! 歌词与音频都留在播放器所在的窗口：跨窗口逐帧推送进度代价太高，也没有必要。
//! 主窗口只推低频增量（换歌 / 换行 / 播放态），Rust 侧保存一份合并后的快照，
//! 歌词窗口挂载时补一次，因此不依赖「主窗口先起来还是歌词窗口先起来」。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::error::{PResult, PlatformError};
use crate::prefs::LyricPos;
use crate::state::AppState;

/// 歌词窗口 label。能力文件（capabilities）里必须同时列出，
/// 否则拖拽这类窗口 API 会在歌词窗口里被权限系统拒掉。
pub const LYRIC_WINDOW: &str = "lyric";
/// 主窗口 → 歌词窗口的快照推送。
pub const UPDATE_EVENT: &str = "lyric:update";
/// 开关状态广播：主界面按钮与歌词窗口自己的关闭按钮都靠它对齐。
pub const STATE_EVENT: &str = "lyric:state";

const DEFAULT_WIDTH: f64 = 780.0;
const DEFAULT_HEIGHT: f64 = 172.0;
const MIN_WIDTH: f64 = 420.0;
const MIN_HEIGHT: f64 = 116.0;
/// 首次出现时距屏幕底部的留白：避开任务栏，也不挡住主界面的播放条。
const EDGE_GAP: i32 = 76;
/// 关闭后多久真正释放歌词 webview。
///
/// 反复开关是常见操作，重建一次要等页面加载，所以刚关掉时只隐藏、随时能秒开；
/// 但一个闲置 webview 常驻几十兆内存，一直留着不值。宽限期过后直接销毁，
/// 下次打开再按需重建 —— 快照存在 Rust 侧，重建后照样立刻接上当前句。
const IDLE_RELEASE: Duration = Duration::from_secs(300);

/// 快照存储。键与前端 `LyricSnapshot` 一一对应，patch 里没出现的键保持原值。
#[derive(Default)]
pub struct DesktopLyric {
    snapshot: Mutex<Value>,
}

impl DesktopLyric {
    pub fn new() -> Self {
        Self {
            snapshot: Mutex::new(empty_snapshot()),
        }
    }

    pub fn snapshot(&self) -> Value {
        self.snapshot
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| empty_snapshot())
    }

    /// 合并增量。`null` 是合法值（例如清空当前曲目），所以只按「键是否出现」判断。
    fn merge(&self, patch: &Value) -> Value {
        let Some(patch) = patch.as_object() else {
            return self.snapshot();
        };
        let mut guard = match self.snapshot.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(target) = guard.as_object_mut() {
            for (key, value) in patch {
                target.insert(key.clone(), value.clone());
            }
        }
        guard.clone()
    }
}

fn empty_snapshot() -> Value {
    json!({ "song": Value::Null, "lines": [], "index": -1, "playing": false })
}

/// 主窗口推送增量：合并后只发给歌词窗口。
///
/// 不回灌主窗口——它自己就是数据源，回灌只会让它做一次无意义的同步。
/// 窗口不存在时命令照样成功，快照先存着，等窗口起来补发。
pub fn sync<R: Runtime>(app: &AppHandle<R>, state: &AppState, patch: &Value) -> Value {
    let merged = state.lyric.merge(patch);
    let _ = app.emit_to(LYRIC_WINDOW, UPDATE_EVENT, &merged);
    merged
}

/// 开 / 关桌面歌词。关闭先只隐藏窗口（webview 留着，再打开立刻能接上当前句），
/// 闲置超过宽限期才真正释放，见 `schedule_idle_release`。
pub fn set_enabled<R: Runtime>(app: &AppHandle<R>, state: &AppState, enabled: bool) -> PResult<Value> {
    if enabled {
        let (window, created) = ensure_window(app)?;
        if created {
            // 新窗口先摆好位置再显示，避免在屏幕角落闪一下；
            // 真正的 show 交给 on_page_load：页面画完才露面，不会先出现白底。
            place_window(app, state, &window)?;
        } else {
            let _ = window.set_always_on_top(true);
            window
                .show()
                .map_err(|error| PlatformError::msg(format!("无法显示桌面歌词：{error}")))?;
        }
    } else if let Some(window) = app.get_webview_window(LYRIC_WINDOW) {
        window
            .hide()
            .map_err(|error| PlatformError::msg(format!("无法隐藏桌面歌词：{error}")))?;
        schedule_idle_release(app.clone());
    }
    let _ = app.emit(STATE_EVENT, json!({ "enabled": enabled }));
    Ok(json!({ "enabled": enabled }))
}

/// 歌词窗口自己关掉时（Alt+F4 / 自带按钮之外的关闭路径），
/// 让主界面按钮跟着回到「关」，避免开关与窗口状态打架。
pub fn notify_disabled<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(STATE_EVENT, json!({ "enabled": false }));
}

/// 宽限期结束后释放歌词 webview。
///
/// 每次隐藏都排一次；任务醒来只做一件事：窗口还在、且仍然不可见，就销毁。
/// 期间被重新打开过则直接返回，交给下一次关闭重新排期，所以重复排期不会误杀。
pub fn schedule_idle_release<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(IDLE_RELEASE).await;
        let Some(window) = app.get_webview_window(LYRIC_WINDOW) else {
            return;
        };
        // 读不到可见性时按「还开着」处理，宁可多留一会儿也不误杀
        if window.is_visible().unwrap_or(true) {
            return;
        }
        let _ = window.destroy();
    });
}

/// 浮窗上的播放控制：复用托盘那条动作通道，播放器只在主窗口里监听。
pub fn dispatch_action<R: Runtime>(app: &AppHandle<R>, action: &str) {
    crate::tray::emit_action(app, action);
}

/// 拖拽结束后记录位置。值没变就不写盘。
pub fn persist_pos(state: &AppState, args: &Value) -> PResult<Value> {
    let x = args.get("x").and_then(Value::as_i64).unwrap_or(0) as i32;
    let y = args.get("y").and_then(Value::as_i64).unwrap_or(0) as i32;
    let next = LyricPos { x, y };
    if state.prefs.get().lyric_pos == Some(next) {
        return Ok(json!({}));
    }
    let merged = state.prefs.preview(&json!({ "lyricPos": next }))?;
    state.prefs.commit(merged);
    Ok(json!({}))
}

fn ensure_window<R: Runtime>(app: &AppHandle<R>) -> PResult<(WebviewWindow<R>, bool)> {
    if let Some(window) = app.get_webview_window(LYRIC_WINDOW) {
        return Ok((window, false));
    }

    let window = WebviewWindowBuilder::new(
        app,
        LYRIC_WINDOW,
        WebviewUrl::App(PathBuf::from("index.html?window=lyric")),
    )
    .title("桌面歌词")
    .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
    .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
    // 无边框 + 透明：窗口里只画一枚圆角胶囊，其余部分透出桌面
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(true)
    // 置顶：不被主界面、浏览器或其他应用盖住
    .always_on_top(true)
    // 不占任务栏，不抢焦点：开关点完焦点仍留在主界面
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .on_page_load(|window, payload| {
        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
            let _ = window.show();
        }
    })
    .build()
    .map_err(|error| PlatformError::msg(format!("无法创建桌面歌词窗口：{error}")))?;

    Ok((window, true))
}

fn place_window<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    window: &WebviewWindow<R>,
) -> PResult<()> {
    let size = window
        .outer_size()
        .map(|size| (size.width as i32, size.height as i32))
        .unwrap_or((DEFAULT_WIDTH as i32, DEFAULT_HEIGHT as i32));
    // 上次的位置在换屏 / 拔掉外接屏之后可能落在不存在的桌面上，这里再夹一次
    let target = state
        .prefs
        .get()
        .lyric_pos
        .and_then(|pos| clamp_to_screen(app, pos, size))
        .unwrap_or_else(|| default_position(app, size));
    window
        .set_position(PhysicalPosition::new(target.0, target.1))
        .map_err(|error| PlatformError::msg(format!("无法放置桌面歌词窗口：{error}")))
}

/// 首次出现的位置：主窗口所在那块屏的底部居中。
fn default_position<R: Runtime>(app: &AppHandle<R>, size: (i32, i32)) -> (i32, i32) {
    let monitor = app
        .get_webview_window(crate::tray::MAIN_WINDOW)
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return (0, 0);
    };
    let origin = monitor.position();
    let area = monitor.size();
    let x = origin.x + (area.width as i32 - size.0) / 2;
    let y = origin.y + area.height as i32 - size.1 - EDGE_GAP;
    (x, y)
}

/// 只要窗口中心还落在某块屏里，就把窗口夹进这块屏的可视区；
/// 否则返回 None，交给默认位置（显示器拔掉后不会把窗口留在虚空里）。
fn clamp_to_screen<R: Runtime>(
    app: &AppHandle<R>,
    pos: LyricPos,
    size: (i32, i32),
) -> Option<(i32, i32)> {
    let monitors = app.available_monitors().ok()?;
    let center = (pos.x + size.0 / 2, pos.y + size.1 / 2);
    for monitor in monitors {
        let origin = monitor.position();
        let area = monitor.size();
        let (left, top) = (origin.x, origin.y);
        let (right, bottom) = (left + area.width as i32, top + area.height as i32);
        if center.0 < left || center.0 > right || center.1 < top || center.1 > bottom {
            continue;
        }
        // 允许贴边或压住半条任务栏，但不让窗口整个跑出可视区
        let x = pos.x.clamp(left - size.0 / 2, (right - size.0 / 2).max(left));
        let y = pos.y.clamp(top, (bottom - size.1).max(top));
        return Some((x, y));
    }
    None
}
