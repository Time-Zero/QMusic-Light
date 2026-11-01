//! 任务栏播放控制面板。
//!
//! 一枚贴在任务栏通知区域左侧（竖排任务栏时在通知区域上方）的胶囊：
//! 圆形封面 · 上一首 · 播放/暂停 · 下一首。和桌面歌词一样，它不持有播放逻辑 ——
//! 主窗口推快照，面板只负责画，按钮动作经 `shell:action` 回到主窗口的播放器。
//!
//! 任务栏是系统的东西：厚度、停靠边、是否自动隐藏、系统明暗主题、有没有全屏应用
//! 盖在上面，随时会被用户改。所以位置与尺寸不是「建好就算」，而是由一个低频巡检
//! （`TICK`）持续对齐；任务栏藏起来或前台是全屏画面时，面板也跟着藏。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

use crate::error::{PResult, PlatformError};
use crate::state::AppState;
use crate::webview;

/// 面板窗口 label。能力文件（capabilities）里必须列出，
/// 否则 `listen` 这类窗口 API 会被权限系统拒掉。
pub const TASKBAR_WINDOW: &str = "taskbar";
/// 主窗口 → 面板的播放态增量。
pub const UPDATE_EVENT: &str = "taskbar:update";
/// 任务栏几何与系统主题：比例、朝向、明暗都在这里下发。
pub const LAYOUT_EVENT: &str = "taskbar:layout";

/// 巡检间隔。任务栏被拖到别的边、自动隐藏、切主题、全屏应用退场都靠它发现；
/// 一次巡检只有几个 Win32 调用，1.2s 足够及时也不费电。
const TICK: Duration = Duration::from_millis(1200);

/*
 * 胶囊的尺寸比例，全部相对胶囊高度 H（前端 CSS 与此逐项对应）：
 *
 *   封面 0.72H   两侧按钮 0.60H   播放键 0.80H
 *   控件间距 0.12H   左右内边距 0.22H
 *
 * 四项控件 + 三道间距 + 两侧内边距 = 3.52H，所以胶囊恒为 3.52 : 1；
 * 圆角取 H/2（CSS 里 `border-radius: 999px` 会被夹到半高），
 * 两端因此是完整半圆，整体轮廓是一枚椭圆胶囊。
 */
const COVER: f64 = 0.72;
const SIDE_BTN: f64 = 0.60;
const PLAY_BTN: f64 = 0.80;
const GAP: f64 = 0.12;
const PAD_X: f64 = 0.22;
const LENGTH: f64 = PAD_X * 2.0 + COVER + SIDE_BTN * 2.0 + PLAY_BTN + GAP * 3.0;

/// 窗口四周给投影留的空白（相对 H）。这块是透明的，只为让阴影不被裁掉；
/// 面板本身高度只占任务栏厚度的 80%，即使加上留白也不会压到上面的内容。
const SHADOW: f64 = 0.15;
/// 胶囊高度占任务栏厚度的比例，并夹在这个区间里（Windows 任务栏 40~60 逻辑像素）。
const FILL: f64 = 0.80;
const MIN_H: f64 = 24.0;
const MAX_H: f64 = 40.0;
/// 自动隐藏的任务栏只剩一条 2px 细边，低于这个厚度就认为它藏着。
const HIDDEN_THICKNESS: i32 = 10;
/// 任务栏找不到通知区域时的兜底留白（逻辑像素），大约让开托盘与时钟。
const TRAY_FALLBACK: f64 = 180.0;

/// 面板此刻能不能露面：任务栏可见 + 没有全屏应用。由巡检写入。
static SHOWABLE: AtomicBool = AtomicBool::new(true);
/// 面板页面是否已画完（前端主动报到）。没画完就 show 会先闪一帧白底或错的主题。
static READY: AtomicBool = AtomicBool::new(false);
/// 巡检任务只起一份：进程内只有一块任务栏。
static WATCHING: AtomicBool = AtomicBool::new(false);

pub fn empty_snapshot() -> Value {
    json!({ "song": Value::Null, "playing": false })
}

/// 主窗口推送播放态增量：合并后只发给面板。
///
/// 窗口不存在时命令照样成功 —— 快照先存着，等面板起来补读。
pub fn sync<R: Runtime>(app: &AppHandle<R>, state: &AppState, patch: &Value) -> Value {
    let merged = state.taskbar.merge(patch);
    let _ = app.emit_to(TASKBAR_WINDOW, UPDATE_EVENT, &merged);
    // 换歌时顺手校正一次：面板刚建好、巡检还没跑第一圈时，
    // 也不该在全屏画面或藏起来的任务栏上闪一下
    align(app);
    refresh_visibility(app);
    merged
}

/// 面板挂载时补读一次：播放态 + 当前任务栏比例（首次布局事件可能早于页面加载）。
pub fn snapshot_json<R: Runtime>(app: &AppHandle<R>, state: &AppState) -> Value {
    let mut value = state.taskbar.get();
    if let Some(object) = value.as_object_mut() {
        object.insert("layout".into(), layout_json(app));
    }
    value
}

/// 面板上的播放控制：复用托盘那条动作通道，播放器只在主窗口里监听。
pub fn dispatch_action<R: Runtime>(app: &AppHandle<R>, action: &str) {
    crate::tray::emit_action(app, action);
}

/// 前端画完第一帧后报到：这时候才允许把窗口显出来。
pub fn mark_ready<R: Runtime>(app: &AppHandle<R>) {
    READY.store(true, Ordering::SeqCst);
    refresh_visibility(app);
}

/// 开关面板。关掉直接销毁 webview：任务栏面板不需要「秒开」，
/// 常驻一个闲置 webview 换来的只是几十兆内存。
pub fn apply_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> PResult<()> {
    if enabled {
        if !cfg!(windows) {
            return Err(PlatformError::msg("任务栏播放控制仅在 Windows 上可用"));
        }
        ensure_window(app)?;
        spawn_watcher(app.clone());
    } else if let Some(window) = app.get_webview_window(TASKBAR_WINDOW) {
        READY.store(false, Ordering::SeqCst);
        let _ = window.destroy();
    }
    Ok(())
}

/// 启动时按偏好恢复。窗口即使建好也不会立刻露面：有当前曲目才显示，见 `refresh_visibility`。
pub fn restore<R: Runtime>(app: &AppHandle<R>) -> PResult<()> {
    // 非 Windows 没有任务栏可贴：开关保持默认值，但不必在启动日志里刷一条错误
    if !cfg!(windows) || !enabled(app) {
        return Ok(());
    }
    apply_enabled(app, true)
}

fn enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<AppState>()
        .map(|state| state.prefs.get().taskbar_panel)
        .unwrap_or(false)
}

/// 有没有当前曲目。`song` 为 null（从没播过 / 清空了队列）时面板整体收起：
/// 一个没有内容的胶囊留在任务栏上，只会白占位置、吞掉托盘附近的点击。
fn has_song<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<AppState>()
        .map(|state| !state.taskbar.get()["song"].is_null())
        .unwrap_or(false)
}

fn refresh_visibility<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(TASKBAR_WINDOW) else {
        return;
    };
    if !READY.load(Ordering::SeqCst) {
        return;
    }
    let want = SHOWABLE.load(Ordering::SeqCst) && enabled(app) && has_song(app);
    let visible = window.is_visible().unwrap_or(false);
    if want == visible {
        return;
    }
    let _ = if want { window.show() } else { window.hide() };
}

fn ensure_window<R: Runtime>(app: &AppHandle<R>) -> PResult<WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window(TASKBAR_WINDOW) {
        return Ok(window);
    }
    // 尺寸取自任务栏实际厚度，页面还没起来也能一次摆对
    let size = measure(scale_of(app))
        .map(|metrics| metrics.size)
        .unwrap_or((130.0, 42.0));
    READY.store(false, Ordering::SeqCst);

    let mut builder = WebviewWindowBuilder::new(
        app,
        TASKBAR_WINDOW,
        WebviewUrl::App(PathBuf::from("index.html?window=taskbar")),
    )
    .title("任务栏播放控制")
    .inner_size(size.0, size.1)
    // 无边框 + 透明：窗口里只画一枚胶囊，其余部分透出任务栏
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    // 置顶：不被任何普通窗口盖住；任务栏自己也是置顶的，所以要压过它
    .always_on_top(true)
    // 不占任务栏按钮、不抢焦点：点面板上的按钮时焦点仍留在用户原来的窗口
    .skip_taskbar(true)
    .focused(false)
    .visible(false);

    // 主窗口的浏览器参数必须原样带上：同一 data 目录下的 webview 共享一个
    // WebView2 浏览器进程，环境选项不一致会直接 ERROR_INVALID_STATE
    if let Some(args) = webview::shared_args(app) {
        builder = builder.additional_browser_args(&args);
    }

    let window = builder
        .build()
        .map_err(|error| PlatformError::msg(format!("无法创建任务栏面板：{error}")))?;

    // WebView2 的透明窗口默认会在点击时激活自己，把用户正在打字的窗口踢到后台。
    // WS_EX_NOACTIVATE：点击不激活但仍投递鼠标消息；WS_EX_TOOLWINDOW：不进 Alt+Tab。
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        platform::make_passive(hwnd);
    }

    let _ = align(app);
    Ok(window)
}

fn spawn_watcher<R: Runtime>(app: AppHandle<R>) {
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut last: Option<Value> = None;
        loop {
            tokio::time::sleep(TICK).await;
            // 关掉之后只留一个空转的心跳：下次打开要快，不值得反复起停任务
            if !enabled(&app) {
                last = None;
                continue;
            }
            let Some(window) = app.get_webview_window(TASKBAR_WINDOW) else {
                last = None;
                continue;
            };
            keep_on_top(&window);
            let Some(applied) = align(&app) else {
                // 拿不到任务栏几何（例如 Explorer 正在重启）：保持原样，下个心跳再试
                continue;
            };
            // 只有比例 / 朝向 / 主题真的变了才打扰前端
            if last.as_ref() != Some(&applied.layout) {
                let _ = window.emit(LAYOUT_EVENT, &applied.layout);
                last = Some(applied.layout);
            }
            refresh_visibility(&app);
        }
    });
}

/// 把窗口对齐一次，并更新「现在能不能露面」：任务栏是否露在外面、前台是不是全屏应用。
fn align<R: Runtime>(app: &AppHandle<R>) -> Option<Applied> {
    let window = app.get_webview_window(TASKBAR_WINDOW)?;
    let applied = apply(app)?;
    SHOWABLE.store(
        applied.visible && !fullscreen_ahead(app, &window),
        Ordering::SeqCst,
    );
    Some(applied)
}

/// 一次对齐：尺寸与位置。返回本次测量结果（含要给前端的比例）。
fn apply<R: Runtime>(app: &AppHandle<R>) -> Option<Applied> {
    let window = app.get_webview_window(TASKBAR_WINDOW)?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let metrics = measure(scale)?;

    let want_size = PhysicalSize::new(
        (metrics.size.0 * scale).round() as u32,
        (metrics.size.1 * scale).round() as u32,
    );
    let resized = window
        .inner_size()
        .map(|current| {
            current.width.abs_diff(want_size.width) > 1
                || current.height.abs_diff(want_size.height) > 1
        })
        .unwrap_or(true);
    if resized {
        let _ = window.set_size(want_size);
    }

    let want_pos = PhysicalPosition::new(metrics.pos.0, metrics.pos.1);
    let moved = window
        .outer_position()
        .map(|current| current != want_pos)
        .unwrap_or(true);
    if moved {
        let _ = window.set_position(want_pos);
    }

    Some(Applied {
        layout: layout_of(&metrics),
        visible: metrics.visible,
    })
}

fn layout_json<R: Runtime>(app: &AppHandle<R>) -> Value {
    let metrics = measure(scale_of(app));
    match metrics {
        Some(metrics) => layout_of(&metrics),
        // 拿不到任务栏（非 Windows / Explorer 未起来）：给一组能看的默认值
        None => layout_of(&Measure {
            h: 32.0,
            pad: 5.0,
            size: (130.0, 42.0),
            pos: (0, 0),
            vertical: false,
            visible: true,
        }),
    }
}

fn layout_of(metrics: &Measure) -> Value {
    json!({
        "h": round1(metrics.h),
        "pad": round1(metrics.pad),
        "axis": if metrics.vertical { "vertical" } else { "horizontal" },
        "theme": platform::theme(),
    })
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn scale_of<R: Runtime>(app: &AppHandle<R>) -> f64 {
    app.get_webview_window(TASKBAR_WINDOW)
        .and_then(|window| window.scale_factor().ok())
        .or_else(|| {
            app.get_webview_window(crate::tray::MAIN_WINDOW)
                .and_then(|window| window.scale_factor().ok())
        })
        .or_else(|| {
            app.primary_monitor()
                .ok()
                .flatten()
                .map(|monitor| monitor.scale_factor())
        })
        .unwrap_or(1.0)
}

struct Applied {
    layout: Value,
    /// 任务栏此刻是否露在外面
    visible: bool,
}

/// 一次任务栏测量的结果。
struct Measure {
    /// 胶囊高度（逻辑像素），前端按它算所有控件尺寸
    h: f64,
    /// 窗口四周留白（逻辑像素）
    pad: f64,
    /// 窗口尺寸（逻辑像素）
    size: (f64, f64),
    /// 窗口位置（物理像素）
    pos: (i32, i32),
    /// 竖排任务栏（停靠左右两侧）：胶囊也跟着竖过来
    vertical: bool,
    /// 任务栏此刻是否可见
    visible: bool,
}

/// 胶囊高度与四周留白（逻辑像素）。
///
/// 高度按任务栏厚度的 `FILL` 取，再夹进 `[MIN_H, MAX_H]`：任务栏被调得很矮时
/// 控件不能小到点不中，被调得很高时也不该长成一条胖横幅。缩放通过 `scale` 折回逻辑，
/// 所以 100% 与 150% 下看到的胶囊是同一个大小。
fn capsule(thickness: i32, scale: f64) -> (f64, f64) {
    // 自动隐藏时厚度只剩 2px 的细边：按它算比例没有意义，用最小厚度占位，
    // 反正窗口会被 `visible = false` 收起
    let logical = thickness.max(HIDDEN_THICKNESS) as f64 / scale;
    let h = (logical * FILL).clamp(MIN_H, MAX_H);
    let pad = (h * SHADOW).round().max(3.0);
    (h, pad)
}

fn measure(scale: f64) -> Option<Measure> {
    let dock = platform::dock()?;
    let thickness = if dock.vertical {
        dock.taskbar.width()
    } else {
        dock.taskbar.height()
    };
    // 自动隐藏的任务栏只剩一条细边：这不是「任务栏变薄了」，而是「它藏起来了」
    let visible = thickness >= HIDDEN_THICKNESS;
    let (h, pad) = capsule(thickness, scale);
    let length = h * LENGTH;
    let size = if dock.vertical {
        (h + pad * 2.0, length + pad * 2.0)
    } else {
        (length + pad * 2.0, h + pad * 2.0)
    };

    let width = (size.0 * scale).round() as i32;
    let height = (size.1 * scale).round() as i32;
    // 贴着通知区域放，中间留一点呼吸；通知区域找不到就按 180 逻辑像素兜底
    let gap = (8.0 * scale).round() as i32;
    let fallback = (TRAY_FALLBACK * scale).round() as i32;

    let pos = if dock.vertical {
        // 竖排任务栏的通知区域在最下端，面板叠在它上方
        let anchor = dock.tray.map(|tray| tray.top).unwrap_or(dock.taskbar.bottom - fallback);
        (
            dock.taskbar.left + (thickness - width) / 2,
            anchor - gap - height,
        )
    } else {
        let anchor = dock.tray.map(|tray| tray.left).unwrap_or(dock.taskbar.right - fallback);
        (
            anchor - gap - width,
            dock.taskbar.top + (thickness - height) / 2,
        )
    };

    Some(Measure {
        h,
        pad,
        size,
        pos,
        vertical: dock.vertical,
        visible,
    })
}

/// 任务栏自己也是置顶窗口：用户点一下任务栏，它就被提到置顶层最前，把面板整个盖住。
/// 只有在真的被压住时才重新置顶 —— 一次 `SetWindowPos` 换回可见性，
/// 平时不动 z 序，也就不会去盖住音量 / 日历这些系统浮层。
#[cfg(windows)]
fn keep_on_top<R: Runtime>(window: &WebviewWindow<R>) {
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    if let Ok(hwnd) = window.hwnd() {
        if platform::covered(hwnd) {
            platform::raise(hwnd);
        }
    }
}

#[cfg(not(windows))]
fn keep_on_top<R: Runtime>(_window: &WebviewWindow<R>) {}

/// 前台窗口盖住了整块屏（全屏视频 / 游戏）：面板必须让位，
/// 否则一枚置顶胶囊会浮在别人的全屏画面里。
#[cfg(windows)]
fn fullscreen_ahead<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) -> bool {
    let Ok(panel) = window.hwnd() else {
        return false;
    };
    let main = app
        .get_webview_window(crate::tray::MAIN_WINDOW)
        .and_then(|window| window.hwnd().ok());
    let Some(rect) = platform::foreground_rect(panel, main) else {
        return false;
    };
    let Ok(monitors) = app.available_monitors() else {
        return false;
    };
    monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        let (left, top) = (origin.x, origin.y);
        let (right, bottom) = (left + size.width as i32, top + size.height as i32);
        // 铺满整块屏才算全屏：最大化窗口会矮一条任务栏，不会被误判
        rect.left <= left + 2
            && rect.top <= top + 2
            && rect.right >= right - 2
            && rect.bottom >= bottom - 2
    })
}

#[cfg(not(windows))]
fn fullscreen_ahead<R: Runtime>(_app: &AppHandle<R>, _window: &WebviewWindow<R>) -> bool {
    false
}

#[derive(Clone, Copy)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl Rect {
    fn width(self) -> i32 {
        self.right - self.left
    }

    fn height(self) -> i32 {
        self.bottom - self.top
    }
}

/// 任务栏与通知区域在屏幕上的位置（物理像素）。
///
/// 只用 `FindWindow` 找 `Shell_TrayWnd` / `TrayNotifyWnd`，
/// 不去问 `SHAppBarMessage`：停靠边由矩形长宽自行判断，
/// 少一层 COM 式的结构体初始化，Explorer 重启期间也不会抛错。
///
/// 只认主屏那条任务栏。副屏的 `Shell_SecondaryTrayWnd` 没有通知区域可对齐，
/// 把面板放过去就会落在屏幕中间，不如不出现。
#[cfg(windows)]
mod platform {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, FindWindowW, GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowRect,
        IsWindowVisible, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, GW_HWNDPREV, HWND_TOPMOST,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    use super::Rect;

    pub struct Dock {
        pub taskbar: Rect,
        /// 通知区域（托盘 + 时钟）；拿不到时由调用方兜底
        pub tray: Option<Rect>,
        /// 竖排任务栏（停靠左右两侧）
        pub vertical: bool,
    }

    pub fn dock() -> Option<Dock> {
        let shell = find(unsafe { FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()) })?;
        let taskbar = rect_of(shell)?;
        // 通知区域在 Win10/11 都还是 TrayNotifyWnd 的子窗口，托盘宽度随图标数量变化，
        // 只有它自己知道左边界，硬编码一个偏移会在图标变多时压住托盘
        let tray = find(unsafe {
            FindWindowExW(Some(shell), None, w!("TrayNotifyWnd"), PCWSTR::null())
        })
        .and_then(rect_of);
        Some(Dock {
            taskbar,
            tray,
            vertical: taskbar.height() > taskbar.width(),
        })
    }

    /// 让窗口点击不激活、不进 Alt+Tab，但鼠标消息照收。
    pub fn make_passive(hwnd: HWND) {
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let next = style | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize;
            if next != style {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
            }
        }
    }

    /// 前台窗口矩形；前台就是自己的面板或主界面、或者取不到时返回 None。
    pub fn foreground_rect(panel: HWND, main: Option<HWND>) -> Option<Rect> {
        let foreground = unsafe { GetForegroundWindow() };
        if foreground.0.is_null() || foreground == panel || Some(foreground) == main {
            return None;
        }
        rect_of(foreground)
    }

    /// 把面板重新提到置顶层最前。
    ///
    /// 不走 `set_always_on_top`：那类封装按「标志位有没有变」短路，
    /// 而这里要的正是「标志位不变、只是重新排一次 z 序」。
    pub fn raise(hwnd: HWND) {
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }

    /// 我们上方是否压着别的可见窗口。沿 z 序往上走一小段就够：
    /// 真会盖住任务栏的窗口（任务栏本身、系统浮层）就在附近。
    pub fn covered(panel: HWND) -> bool {
        let Some(ours) = rect_of(panel) else {
            return false;
        };
        let mut above = next_above(panel);
        for _ in 0..16 {
            let Some(hwnd) = above else {
                break;
            };
            if unsafe { IsWindowVisible(hwnd) }.as_bool() {
                if let Some(other) = rect_of(hwnd) {
                    if overlaps(ours, other) {
                        return true;
                    }
                }
            }
            above = next_above(hwnd);
        }
        false
    }

    fn next_above(hwnd: HWND) -> Option<HWND> {
        unsafe { GetWindow(hwnd, GW_HWNDPREV) }
            .ok()
            .filter(|next| !next.0.is_null())
    }

    fn overlaps(a: Rect, b: Rect) -> bool {
        a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    }

    /// 任务栏用的是系统色，不是应用色：跟随「Windows 模式」这一项。
    pub fn theme() -> &'static str {
        let mut value: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
                w!("SystemUsesLightTheme"),
                RRF_RT_REG_DWORD,
                None,
                Some(&mut value as *mut u32 as *mut core::ffi::c_void),
                Some(&mut size),
            )
        };
        // 读不到（精简版系统 / 策略禁用）时按暗色画：任务栏默认是深的
        if status.0 == 0 && value != 0 {
            "light"
        } else {
            "dark"
        }
    }

    fn find(result: windows::core::Result<HWND>) -> Option<HWND> {
        result.ok().filter(|hwnd| !hwnd.0.is_null())
    }

    fn rect_of(hwnd: HWND) -> Option<Rect> {
        let mut rect = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut rect).ok()? };
        Some(Rect {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        })
    }
}

#[cfg(not(windows))]
mod platform {
    use super::Rect;

    #[allow(dead_code)]
    pub struct Dock {
        pub taskbar: Rect,
        pub tray: Option<Rect>,
        pub vertical: bool,
    }

    pub fn dock() -> Option<Dock> {
        None
    }

    pub fn theme() -> &'static str {
        "dark"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 四项控件 + 三道间距 + 两侧内边距 = 3.52H。前端 taskbar.css 用的是同一组比例，
    /// 两边任何一处改动都会让胶囊与窗口对不齐，所以先把这条锁住。
    #[test]
    fn capsule_length_matches_css_ratio() {
        assert!((LENGTH - 3.52).abs() < 1e-9, "{LENGTH}");
    }

    #[test]
    fn capsule_keeps_size_across_dpi() {
        // Windows 11 的任务栏：48px @100%、72px @150%、96px @200%
        let (h100, pad100) = capsule(48, 1.0);
        let (h150, pad150) = capsule(72, 1.5);
        let (h200, _) = capsule(96, 2.0);
        assert!((h100 - h150).abs() < 0.5, "{h100} vs {h150}");
        assert!((h100 - h200).abs() < 0.5, "{h100} vs {h200}");
        assert_eq!(pad100, pad150);
        // 留白要留得出来，但别把胶囊挤成一条缝
        assert!(pad100 >= 3.0 && pad100 < h100 / 2.0);
    }

    #[test]
    fn capsule_clamps_extreme_taskbars() {
        // 自动隐藏时只剩细边
        assert_eq!(capsule(12, 1.0).0, MIN_H);
        // 任务栏被拉到很高
        assert_eq!(capsule(400, 1.0).0, MAX_H);
    }
}
