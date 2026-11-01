use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// 主窗口 label，与 `tauri.conf.json` 的 `windows[0].label` 一致。
pub const MAIN_WINDOW: &str = "main";
/// 冷启动竞态：连点两次 exe 时第二个进程可能抢在首实例窗口建好之前，短暂重试即可
const ACTIVATE_RETRIES: usize = 10;
const ACTIVATE_INTERVAL: Duration = Duration::from_millis(150);

pub const TRAY_ID: &str = "qmusic-tray";
/// 托盘 → 前端的动作通道（播放控制要落在持有 Audio 元素的渲染层）。
pub const ACTION_EVENT: &str = "shell:action";

/// 常驻托盘：收起窗口后音频继续播，退出只能从托盘菜单显式触发。
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
    let play = MenuItem::with_id(app, "play", "播放 / 暂停", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "上一首", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "下一首", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 QQ 音乐 Lite", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &play, &prev, &next, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("QQ 音乐 Lite")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "play" => emit_action(app, "toggle"),
            "prev" => emit_action(app, "prev"),
            "next" => emit_action(app, "next"),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => toggle_main(tray.app_handle()),
            TrayIconEvent::DoubleClick { .. } => show_main(tray.app_handle()),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// 把主面板重新交到用户眼前：前台、最小化、收进托盘三种状态都收敛到
/// 「任务栏有按钮 + 未最小化 + 可见 + 前台聚焦」；已在前台时只是重复聚焦，不会重建窗口。
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if reveal_main(app) {
        return;
    }
    // 窗口尚未建好（第二次启动抢在首实例窗口之前）：稍等再试，别让用户觉得点了没反应
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..ACTIVATE_RETRIES {
            tokio::time::sleep(ACTIVATE_INTERVAL).await;
            if reveal_main(&app) {
                return;
            }
        }
    });
}

/// 返回 false 表示主窗口还不存在（调用方决定是否重试）。
fn reveal_main<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return false;
    };
    // 收进托盘时窗口是隐藏的，先还原任务栏按钮再显示，避免「唤回了却找不到在哪」
    let _ = window.set_skip_taskbar(false);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    true
}

pub fn toggle_main<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window(MAIN_WINDOW) {
        Some(window) if window.is_visible().unwrap_or(false) => {
            let _ = window.hide();
        }
        _ => show_main(app),
    }
}

/// 把当前曲目写进托盘悬浮提示，鼠标移上去就能看到在放什么。
pub fn sync_tooltip<R: Runtime>(app: &AppHandle<R>, title: &str, playing: bool) {
    let title = title.trim();
    let text = if title.is_empty() {
        "QQ 音乐 Lite".to_string()
    } else {
        format!("{} · {title}", if playing { "正在播放" } else { "已暂停" })
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(text));
    }
}

/// 播放动作统一从这里下发：托盘菜单与桌面歌词浮窗共用同一条事件通道。
pub fn emit_action<R: Runtime>(app: &AppHandle<R>, action: &str) {
    let _ = app.emit(ACTION_EVENT, serde_json::json!({ "action": action }));
}
