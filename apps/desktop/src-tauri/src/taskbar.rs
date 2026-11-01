//! 任务栏播放控制面板。
//!
//! 一枚贴在任务栏通知区域左侧（竖排任务栏时在通知区域上方）的胶囊：
//! 圆形封面 · 上一首 · 播放/暂停 · 下一首。和桌面歌词一样，它不持有播放逻辑 ——
//! 主窗口推快照，面板只负责画，按钮动作经 `shell:action` 回到主窗口的播放器。
//!
//! 任务栏是系统的东西：厚度、停靠边、是否自动隐藏、系统明暗主题、有没有全屏应用
//! 盖在上面，随时会被用户改。所以位置与尺寸不是「建好就算」，而是由一个低频巡检
//! （`TICK`）持续对齐；任务栏藏起来或前台是全屏画面时，面板也跟着藏。
//!
//! 位置默认紧贴通知区域；设置里可以让它沿任务栏挪开（`MAX_TASKBAR_SHIFT`），
//! 但只允许往远离托盘的一头走，两头都由 `shifted` 夹在任务栏范围内。
//!
//! 另外还有一条 20ms 的 z 序守卫（`GUARD_TICK`）：面板是压在任务栏上的独立置顶窗口，
//! 而任务栏一旦被激活就会排到它前面，把面板整个盖住。这种遮挡必须在一两帧内抢回来，
//! 挂在 1.2s 的巡检上就会变成用户眼里的「闪一下」。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

use crate::error::{PResult, PlatformError};
use crate::prefs::MAX_TASKBAR_SHIFT;
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

/// 「想藏」要连续成立几拍才真的藏。全屏误判、任务栏自动隐藏的边界抖动
/// 通常只持续一拍，为它闪一下不值当。
const HIDE_DWELL: u32 = 2;
/// 两次重新置顶之间的最小间隔。只用来挡住病态的自激（比如另一个置顶窗口
/// 跟我们对着抢），不能设大：它就是「被任务栏盖住多久」的下限。
const RAISE_COOLDOWN: Duration = Duration::from_millis(100);
/// z 序守卫的心跳。
///
/// 任务栏被激活时会排到置顶层最前，把面板整个盖住：点托盘「显示隐藏图标」、
/// 浮层关闭、点任务栏空白处都会触发。几何巡检的 1.2s 周期等不起 ——
/// 用户看到的就是面板「消失一下再回来」。所以单独一条轻量心跳只做一件事：
/// 被盖住了就立刻抢回来，代价是两次 Win32 调用。
const GUARD_TICK: Duration = Duration::from_millis(20);
/// 判定目标几何是否算「变了」的容差（物理像素）。托盘图标增减、
/// DPI 取整都会带来一两像素的抖动，不值得为它重排窗口。
const GEOMETRY_SLACK: i32 = 2;

/// 面板此刻能不能露面：任务栏可见 + 没有全屏应用。由巡检写入。
static SHOWABLE: AtomicBool = AtomicBool::new(true);
/// 任务栏本身是否露在屏幕上。这是「硬信号」：自动隐藏或隐藏任务栏时
/// 面板要立刻跟着收起，不必等迟滞。
static TASKBAR_SHOWN: AtomicBool = AtomicBool::new(true);
/// 面板页面是否已画完（前端主动报到）。没画完就 show 会先闪一帧白底或错的主题。
static READY: AtomicBool = AtomicBool::new(false);
/// 巡检任务只起一份：进程内只有一块任务栏。
static WATCHING: AtomicBool = AtomicBool::new(false);
/// z 序守卫同样只起一份。
static GUARDING: AtomicBool = AtomicBool::new(false);
/// 「想藏」已经连续成立了几拍，见 `refresh_visibility`。
static UNWANTED: AtomicU32 = AtomicU32::new(0);
/// 上一次真正写进窗口的目标几何。任务栏没动时，巡检一次 `SetWindowPos` 都不发。
static WRITTEN: Mutex<Option<Target>> = Mutex::new(None);
/// 上一次重新置顶的时刻，配合 `RAISE_COOLDOWN` 限流。
static LAST_RAISE: Mutex<Option<Instant>> = Mutex::new(None);

/// 面板窗口的目标几何（物理像素）。只用来回答「这一拍要不要动窗口」。
#[derive(Clone, Copy, PartialEq, Eq)]
struct Target {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl Target {
    /// 尺寸算不算「没变」。分开判尺寸与位置，是为了让「只是挪个位置」的巡检
    /// 不会顺带发一次 resize —— 对透明窗口来说，那等于重建一次合成表面。
    fn same_size(self, other: Self) -> bool {
        self.width.abs_diff(other.width) <= GEOMETRY_SLACK as u32
            && self.height.abs_diff(other.height) <= GEOMETRY_SLACK as u32
    }

    fn same_place(self, other: Self) -> bool {
        (self.x - other.x).abs() <= GEOMETRY_SLACK
            && (self.y - other.y).abs() <= GEOMETRY_SLACK
    }
}

fn written_target() -> Option<Target> {
    WRITTEN.lock().ok().and_then(|written| *written)
}

fn remember_target(target: Target) {
    if let Ok(mut written) = WRITTEN.lock() {
        *written = Some(target);
    }
}

/// 窗口重建后必须忘掉上一次写过的几何：新窗口是摆回默认位置的，
/// 就算目标值一模一样，也得再写一次才能贴回任务栏。
fn forget_target() {
    if let Ok(mut written) = WRITTEN.lock() {
        *written = None;
    }
}

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
    let _ = refresh_visibility(app);
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
    let _ = refresh_visibility(app);
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
        spawn_zorder_guard(app.clone());
    } else if let Some(window) = app.get_webview_window(TASKBAR_WINDOW) {
        READY.store(false, Ordering::SeqCst);
        UNWANTED.store(0, Ordering::SeqCst);
        forget_target();
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

/// 用户给面板挪出来的位移（逻辑像素），0 就是贴着通知区域的默认摆位。
fn shift_of<R: Runtime>(app: &AppHandle<R>) -> i32 {
    app.try_state::<AppState>()
        .map(|state| state.prefs.get().taskbar_shift)
        .unwrap_or(0)
}

/// 偏好里的位移变了：立刻重排一次。
///
/// 巡检每 1.2s 才跑一拍，设置页点一下「←」要等一个周期才动，
/// 用起来就像按钮没生效；所以这里手动催一次，让面板当场跟手。
pub fn realign<R: Runtime>(app: &AppHandle<R>) {
    align(app);
}

/// 有没有当前曲目。`song` 为 null（从没播过 / 清空了队列）时面板整体收起：
/// 一个没有内容的胶囊留在任务栏上，只会白占位置、吞掉托盘附近的点击。
fn has_song<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<AppState>()
        .map(|state| !state.taskbar.get()["song"].is_null())
        .unwrap_or(false)
}

/// 对齐「该不该露面」与窗口现状。返回值只用于巡检日志。
fn refresh_visibility<R: Runtime>(app: &AppHandle<R>) -> &'static str {
    let Some(window) = app.get_webview_window(TASKBAR_WINDOW) else {
        return "window-gone";
    };
    if !READY.load(Ordering::SeqCst) {
        return "page-loading";
    }
    let want = SHOWABLE.load(Ordering::SeqCst) && enabled(app) && has_song(app);
    let visible = window.is_visible().unwrap_or(false);

    if want {
        UNWANTED.store(0, Ordering::SeqCst);
        if visible {
            return "keep";
        }
        let _ = window.show();
        return "show";
    }

    if !visible {
        UNWANTED.store(0, Ordering::SeqCst);
        return "keep-hidden";
    }

    // 任务栏本身收起来了（自动隐藏 / 隐藏任务栏）：硬信号，跟着它走，不等待迟滞
    if !TASKBAR_SHOWN.load(Ordering::SeqCst) {
        UNWANTED.store(0, Ordering::SeqCst);
        let _ = window.hide();
        return "hide(taskbar)";
    }

    // 其余都是「软」信号（前台全屏、暂时没有曲目）：等它在连续几拍里都成立再藏。
    // 只抖一拍的判定不该让面板闪一下。
    let misses = UNWANTED.fetch_add(1, Ordering::SeqCst) + 1;
    if misses < HIDE_DWELL {
        return "hold";
    }
    UNWANTED.store(0, Ordering::SeqCst);
    let _ = window.hide();
    "hide"
}

fn ensure_window<R: Runtime>(app: &AppHandle<R>) -> PResult<WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window(TASKBAR_WINDOW) {
        return Ok(window);
    }
    // 尺寸取自任务栏实际厚度，页面还没起来也能一次摆对
    let size = measure(scale_of(app), shift_of(app))
        .map(|metrics| metrics.size)
        .unwrap_or((130.0, 42.0));
    READY.store(false, Ordering::SeqCst);
    // 新窗口是摆在默认位置的：上一轮记下的几何作废，否则「目标没变」会让我们
    // 跳过第一次定位，窗口就停在屏幕中央不动了
    forget_target();
    UNWANTED.store(0, Ordering::SeqCst);

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

/// z 序守卫：只负责「被任务栏盖住就立刻抢回来」。
///
/// 这条心跳刻意和几何巡检分开：巡检 1.2s 一次是为了省电（读注册表、枚举显示器），
/// 而 z 序的恢复必须在一两帧内完成，否则用户看到的就是面板闪一下。
fn spawn_zorder_guard<R: Runtime>(app: AppHandle<R>) {
    if !cfg!(windows) || GUARDING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(GUARD_TICK).await;
            // 先看窗口在不在（关掉开关时窗口会销毁），再谈偏好：
            // 这条心跳 50Hz 在跑，能省一次偏好克隆就省
            let Some(window) = app.get_webview_window(TASKBAR_WINDOW) else {
                continue;
            };
            if !enabled(&app) {
                continue;
            }
            ensure_on_top(&window);
        }
    });
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
            let (covered, raised) = ensure_on_top(&window);
            let Some(applied) = align(&app) else {
                // 拿不到任务栏几何（例如 Explorer 正在重启）：保持原样，下个心跳再试
                continue;
            };
            // 只有比例 / 朝向 / 主题真的变了才打扰前端
            if last.as_ref() != Some(&applied.layout) {
                let _ = window.emit(LAYOUT_EVENT, &applied.layout);
                last = Some(applied.layout.clone());
            }
            let action = refresh_visibility(&app);
            if trace_on() {
                trace_tick(&applied, covered, raised, action, &foreground_hint(&app, &window));
            }
        }
    });
}

/// 把窗口对齐一次，并更新「现在能不能露面」：任务栏是否露在外面、前台是不是全屏应用。
fn align<R: Runtime>(app: &AppHandle<R>) -> Option<Applied> {
    let window = app.get_webview_window(TASKBAR_WINDOW)?;
    let applied = apply(app)?;
    let fullscreen = applied.visible && fullscreen_ahead(app, &window, applied.taskbar);
    TASKBAR_SHOWN.store(applied.visible, Ordering::SeqCst);
    SHOWABLE.store(applied.visible && !fullscreen, Ordering::SeqCst);
    Some(applied)
}

/// 一次对齐：尺寸与位置。返回本次测量结果（含要给前端的比例）。
///
/// 只有「目标几何」真的变了才碰窗口。巡检每秒都在跑，但任务栏不动时一次
/// `SetWindowPos` 都不发 —— 否则透明窗口每拍都会被重新合成一遍，看着就是规律闪烁。
/// 比较用 `GEOMETRY_SLACK` 的容差，而不是逐像素相等：否则实际位置只要因为
/// DPI 取整差 1px，就会形成「写→系统对齐→下拍又不等→再写」的自激循环。
fn apply<R: Runtime>(app: &AppHandle<R>) -> Option<Applied> {
    let window = app.get_webview_window(TASKBAR_WINDOW)?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let metrics = measure(scale, shift_of(app))?;

    let target = Target {
        x: metrics.pos.0,
        y: metrics.pos.1,
        width: (metrics.size.0 * scale).round() as u32,
        height: (metrics.size.1 * scale).round() as u32,
    };

    let written = written_target();
    let size_changed = written.map_or(true, |written| !written.same_size(target));
    let pos_changed = written.map_or(true, |written| !written.same_place(target));

    // 尺寸与位置分开写。给透明窗口发一次「尺寸其实没变」的 resize，
    // WebView2 也会重建一次合成表面 —— 托盘图标增减只会挪位置，
    // 这种时候多发一个 set_size，用户看到的就是一帧空白。
    if size_changed {
        let _ = window.set_size(PhysicalSize::new(target.width, target.height));
    }
    if size_changed || pos_changed {
        let _ = window.set_position(PhysicalPosition::new(target.x, target.y));
        remember_target(target);
    }

    Some(Applied {
        wrote: size_changed || pos_changed,
        taskbar: metrics.taskbar,
        target,
        layout: layout_of(&metrics),
        visible: metrics.visible,
    })
}

fn layout_json<R: Runtime>(app: &AppHandle<R>) -> Value {
    let metrics = measure(scale_of(app), shift_of(app));
    match metrics {
        Some(metrics) => layout_of(&metrics),
        // 拿不到任务栏（非 Windows / Explorer 未起来）：给一组能看的默认值
        None => layout_of(&Measure {
            h: 32.0,
            pad: 5.0,
            size: (130.0, 42.0),
            pos: (0, 0),
            taskbar: Rect {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            },
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
    /// 任务栏矩形（物理像素）：用来判断面板属于哪块屏、以及和日志对照
    taskbar: Rect,
    /// 这一拍有没有真的动过窗口
    wrote: bool,
    /// 这一拍算出的目标几何
    target: Target,
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
    /// 任务栏矩形（物理像素），含停靠边信息
    taskbar: Rect,
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

/// 默认摆位 `default` 沿任务栏方向挪开 `shift` 之后的坐标。
///
/// 位移只往「离开通知区域」的一头走（水平任务栏向左、竖排任务栏向上），
/// 并且两头都夹住：最多推到任务栏起始边 `start`，最少回到默认摆位。
/// 也就是说这枚胶囊可以沿着任务栏滑，但不会盖住托盘图标、也不会跑出任务栏。
fn shifted(default: i32, shift: i32, start: i32) -> i32 {
    // 先夹住「不越过默认摆位」（挡住负偏移），再夹住「不越过任务栏起始边」。
    // 顺序不能反：默认摆位本身落在起始边外时，任务栏边界才是硬约束。
    (default - shift).min(default).max(start)
}

/// 量一次任务栏。`shift` 是用户在设置里给面板挪出来的位移（逻辑像素）。
fn measure(scale: f64, shift: i32) -> Option<Measure> {
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
    // 用户挪出来的位移按逻辑像素存，这里折成物理像素
    let shift = (shift.clamp(0, MAX_TASKBAR_SHIFT) as f64 * scale).round() as i32;

    let pos = if dock.vertical {
        // 竖排任务栏的通知区域在最下端，面板叠在它上方
        let anchor = dock.tray.map(|tray| tray.top).unwrap_or(dock.taskbar.bottom - fallback);
        (
            dock.taskbar.left + (thickness - width) / 2,
            shifted(anchor - gap - height, shift, dock.taskbar.top),
        )
    } else {
        let anchor = dock.tray.map(|tray| tray.left).unwrap_or(dock.taskbar.right - fallback);
        (
            shifted(anchor - gap - width, shift, dock.taskbar.left),
            dock.taskbar.top + (thickness - height) / 2,
        )
    };

    Some(Measure {
        h,
        pad,
        size,
        pos,
        taskbar: dock.taskbar,
        vertical: dock.vertical,
        visible,
    })
}

/// 任务栏自己也是置顶窗口：它一旦被激活（点托盘浮层、点任务栏空白处）就会排到
/// 置顶层最前，把面板整个盖住。面板压在任务栏上这件事本身没错，错的是「被盖住
/// 多久才抢回来」—— 实测被盖住的那段时间里，那块屏幕区域画的就是任务栏。
///
/// 所以这里只做一件事：被压住就立刻 `SetWindowPos` 抢回置顶。
/// 由 20ms 的 `spawn_zorder_guard` 驱动，恢复时间从「一个巡检周期」压到一两帧；
/// `RAISE_COOLDOWN` 只是防止另一个置顶窗口跟我们对着抢时的病态自激。
///
/// 返回 `(是否被压住, 是否真的重新置顶)`，只用于巡检日志。
#[cfg(windows)]
fn ensure_on_top<R: Runtime>(window: &WebviewWindow<R>) -> (bool, bool) {
    let Ok(hwnd) = window.hwnd() else {
        return (false, false);
    };
    // 直接问 Win32：这条路径 50Hz 在跑，不能每次都同步回主线程问 Tauri
    if !platform::is_visible(hwnd) {
        return (false, false);
    }
    if !platform::covered_by_taskbar(hwnd) {
        return (false, false);
    }
    let now = Instant::now();
    let Ok(mut last) = LAST_RAISE.lock() else {
        return (true, false);
    };
    if last.map_or(false, |at| now.duration_since(at) < RAISE_COOLDOWN) {
        return (true, false);
    }
    platform::raise(hwnd);
    *last = Some(now);
    (true, true)
}

#[cfg(not(windows))]
fn ensure_on_top<R: Runtime>(_window: &WebviewWindow<R>) -> (bool, bool) {
    (false, false)
}

/// 前台窗口盖住了整块屏（全屏视频 / 游戏）：面板必须让位，
/// 否则一枚置顶胶囊会浮在别人的全屏画面里。
///
/// 只比**任务栏所在那块屏**。早先写成「任意一块屏被铺满就算全屏」，
/// 副屏放全屏视频时主屏的面板也会被藏起来，看着就是无缘无故消失又回来。
#[cfg(windows)]
fn fullscreen_ahead<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    taskbar: Rect,
) -> bool {
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
    // 任务栏中心点落在哪块屏上，就只拿那块屏做比较
    let center = (
        taskbar.left + taskbar.width() / 2,
        taskbar.top + taskbar.height() / 2,
    );
    let Some(monitor) = monitors.iter().find(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        center.0 >= origin.x
            && center.0 < origin.x + size.width as i32
            && center.1 >= origin.y
            && center.1 < origin.y + size.height as i32
    }) else {
        return false;
    };

    let origin = monitor.position();
    let size = monitor.size();
    let (left, top) = (origin.x, origin.y);
    let (right, bottom) = (left + size.width as i32, top + size.height as i32);
    // 铺满整块屏才算全屏：最大化窗口会矮一条任务栏，不会被误判
    rect.left <= left + 2
        && rect.top <= top + 2
        && rect.right >= right - 2
        && rect.bottom >= bottom - 2
}

#[cfg(not(windows))]
fn fullscreen_ahead<R: Runtime>(
    _app: &AppHandle<R>,
    _window: &WebviewWindow<R>,
    _taskbar: Rect,
) -> bool {
    false
}

/// 巡检日志开关：设了 `QMUSIC_TASKBAR_LOG` 就每拍打一行，
/// 用来把「看见的闪」和「代码里的动作」对到同一根时间轴上。
fn trace_on() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("QMUSIC_TASKBAR_LOG").is_some())
}

fn trace_tick(
    applied: &Applied,
    covered: bool,
    raised: bool,
    action: &str,
    foreground: &str,
) {
    static START: OnceLock<Instant> = OnceLock::new();
    let elapsed = START.get_or_init(Instant::now).elapsed().as_secs_f64();

    eprintln!(
        "[taskbar +{elapsed:>8.1}s] taskbar=({},{},{}x{}) target=({},{} {}x{}) wrote={} covered={} raised={} showable={} fg={foreground} action={action}",
        applied.taskbar.left,
        applied.taskbar.top,
        applied.taskbar.width(),
        applied.taskbar.height(),
        applied.target.x,
        applied.target.y,
        applied.target.width,
        applied.target.height,
        applied.wrote,
        covered,
        raised,
        SHOWABLE.load(Ordering::SeqCst),
    );
}

/// 前台窗口的类名。点开托盘溢出、开始菜单时，这一列会直接告诉我们是哪个
/// shell 浮层顶到了前台 —— 排查「点一下系统图标面板就闪」时最有用。
#[cfg(windows)]
fn foreground_hint<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) -> String {
    let main = app
        .get_webview_window(crate::tray::MAIN_WINDOW)
        .and_then(|window| window.hwnd().ok());
    match window.hwnd() {
        Ok(panel) => platform::foreground_class(panel, main).unwrap_or_else(|| "-".into()),
        Err(_) => "-".into(),
    }
}

#[cfg(not(windows))]
fn foreground_hint<R: Runtime>(_app: &AppHandle<R>, _window: &WebviewWindow<R>) -> String {
    "-".into()
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
        FindWindowExW, FindWindowW, GetClassNameW, GetForegroundWindow, GetWindow, GetWindowLongPtrW,
        GetWindowRect, IsWindowVisible, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, GW_HWNDPREV,
        GW_OWNER, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW,
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
    ///
    /// 只有「用户在看的内容窗口」才算数，见 `is_content_window`。
    pub fn foreground_rect(panel: HWND, main: Option<HWND>) -> Option<Rect> {
        let foreground = not_ours(panel, main)?;
        if !is_content_window(foreground) {
            return None;
        }
        rect_of(foreground)
    }

    /// 前台窗口的类名，只给巡检日志用。
    pub fn foreground_class(panel: HWND, main: Option<HWND>) -> Option<String> {
        not_ours(panel, main).and_then(class_of)
    }

    fn not_ours(panel: HWND, main: Option<HWND>) -> Option<HWND> {
        let foreground = unsafe { GetForegroundWindow() };
        if foreground.0.is_null() || foreground == panel || Some(foreground) == main {
            return None;
        }
        Some(foreground)
    }

    /// 是不是「用户真正在看的内容窗口」。
    ///
    /// 托盘的溢出浮层（`TopLevelWindowForOverflowXamlIsland` /
    /// `NotifyIconOverflowWindow`）这类 shell 宿主窗口经常铺满整块屏，
    /// 却只是几个隐藏图标的弹层。早先不加区分，点一下「显示隐藏图标」
    /// 面板就误判成「有全屏应用」而藏起来 —— 正是那次「闪一下」的来源。
    fn is_content_window(hwnd: HWND) -> bool {
        // 工具窗口、被别人 owner 的窗口，都是附属界面
        let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
        if style & WS_EX_TOOLWINDOW.0 != 0 {
            return false;
        }
        if unsafe { GetWindow(hwnd, GW_OWNER) }.map_or(false, |owner| !owner.0.is_null()) {
            return false;
        }
        !matches!(
            class_of(hwnd).as_deref(),
            Some("Shell_TrayWnd")
                | Some("Shell_SecondaryTrayWnd")
                | Some("NotifyIconOverflowWindow")
                | Some("TopLevelWindowForOverflowXamlIsland")
                | Some("XamlExplorerHostIslandWindow")
                | Some("Windows.UI.Core.CoreWindow")
                | Some("ForegroundStaging")
        )
    }

    fn class_of(hwnd: HWND) -> Option<String> {
        let mut buffer = [0u16; 128];
        let length = unsafe { GetClassNameW(hwnd, &mut buffer) };
        if length <= 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buffer[..length as usize]))
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

    /// 窗口当前是否可见。走 Win32 而不是 Tauri 的封装：z 序守卫每秒要问几十次，
    /// 不能让每次询问都变成一次「回到主线程」的同步调用。
    pub fn is_visible(hwnd: HWND) -> bool {
        unsafe { IsWindowVisible(hwnd) }.as_bool()
    }

    /// 任务栏自己是否压在我们上面。
    ///
    /// 只认任务栏：托盘溢出浮层、通知、输入法候选窗这些短命窗口就算盖住了
    /// 也不值得重排一次 z 序 —— 而 `SetWindowPos` 会让透明窗口重新合成一遍，
    /// 用户看到的就是这一下闪。它们本来就只存在一两秒，让开也无所谓。
    pub fn covered_by_taskbar(panel: HWND) -> bool {
        let Some(taskbar) = find(unsafe { FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()) }) else {
            return false;
        };
        let mut above = next_above(panel);
        for _ in 0..32 {
            let Some(hwnd) = above else {
                break;
            };
            if hwnd == taskbar {
                return true;
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

    /// 位移只往远离托盘的一头走，并且被任务栏起始边夹住：
    /// 否则「再点一下」会把面板推到屏幕外或压到托盘图标上。
    #[test]
    fn shift_slides_along_taskbar_within_edges() {
        // 默认贴托盘、任务栏左边界在 0：往左 40px 就是 40
        assert_eq!(shifted(1500, 40, 0), 1460);
        // 挪过头就停在任务栏起始边
        assert_eq!(shifted(1500, 5000, 0), 0);
        // 负数（往托盘里挤）没有意义，原地不动
        assert_eq!(shifted(1500, -40, 0), 1500);
        // 默认摆位本身就在边界外时，不要反弹到更远的地方
        assert_eq!(shifted(-30, 0, 0), 0);
    }

    #[test]
    fn capsule_clamps_extreme_taskbars() {
        // 自动隐藏时只剩细边
        assert_eq!(capsule(12, 1.0).0, MIN_H);
        // 任务栏被拉到很高
        assert_eq!(capsule(400, 1.0).0, MAX_H);
    }

    /// 巡检每次都比对目标几何：差一两像素必须判成「没变」，
    /// 否则 DPI 取整会让窗口每拍都被重排一次，正是闪烁的来源。
    #[test]
    fn target_tolerates_jitter_but_not_real_moves() {
        let base = Target {
            x: 2687,
            y: 1404,
            width: 135,
            height: 38,
        };
        let jitter = Target {
            x: 2686,
            y: 1405,
            width: 134,
            height: 38,
        };
        assert!(base.same_size(jitter));
        assert!(base.same_place(jitter));
        assert!(jitter.same_size(base));
        assert!(jitter.same_place(base));

        // 纯位移：只该判成「位置变了」，尺寸仍是原样，才不会被顺手 resize 一次
        let shifted = Target {
            x: 2700,
            ..base
        };
        assert!(!base.same_place(shifted));
        assert!(base.same_size(shifted));

        // 纯换尺寸：位置不动
        let resized = Target {
            width: 200,
            ..base
        };
        assert!(!base.same_size(resized));
        assert!(base.same_place(resized));
    }
}
