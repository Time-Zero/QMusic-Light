#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod cache;
mod commands;
mod cookies;
mod db;
mod error;
mod hash33;
mod lyric;
mod models;
mod net;
mod picker;
mod prefs;
mod protocol;
mod qq_api;
mod secret;
mod state;
mod tray;

use tauri::Manager;

use crate::state::AppState;

/// 播放缓存目录通过自定义协议回放，Windows 下实际地址是 http://qmcache.localhost/。
const CACHE_SCHEME: &str = "qmcache";

fn main() {
    tauri::Builder::default()
        // 单实例守卫必须最先注册：第二个进程在插件初始化阶段就被判重并退出，
        // setup（SQLite / 钥匙串 / 托盘）不会跑第二遍，而是把「用户又点了一次 exe」转成一次面板唤醒。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 已经在跑的实例收到唤醒请求：前台、最小化、收进托盘三种状态都收敛到「可见 + 聚焦」
            tray::show_main(app);
        }))
        .register_asynchronous_uri_scheme_protocol(CACHE_SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            // 整首读取可能几 MB，放到阻塞线程池，别占用 webview 的请求线程
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(protocol::respond(&app, &request));
            });
        })
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let state = AppState::new(data_dir)?;
            let tray_ready = match tray::build(app.handle()) {
                Ok(()) => true,
                Err(error) => {
                    // 托盘建不起来也不该拦着用户用应用，只是关窗口时不能再藏起来
                    eprintln!("托盘初始化失败：{error}");
                    false
                }
            };
            state.set_tray_ready(tray_ready);
            app.manage(state);
            Ok(())
        })
        .on_window_event(|window, event| {
            // 桌面歌词浮窗不是主界面：关掉它只等于关掉歌词，
            // 不能走「收进托盘」那条路，否则开关与窗口状态会打架。
            if window.label() == lyric::LYRIC_WINDOW {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                    lyric::notify_disabled(window.app_handle());
                    // 走 Alt+F4 关掉的那条路也要排期，否则这个 webview 会一直挂到退出
                    lyric::schedule_idle_release(window.app_handle().clone());
                }
                return;
            }

            let flags = window.try_state::<AppState>().map(|state| {
                let prefs = state.prefs.get();
                (
                    prefs.close_action == "tray",
                    prefs.minimize_to_tray,
                    state.tray_ready(),
                )
            });
            // 托盘不可用时一律走默认行为，避免窗口藏起来再也叫不回
            let (close_to_tray, minimize_to_tray, tray_ready) =
                flags.unwrap_or((false, false, false));

            match event {
                // 点叉：按偏好收起窗口（音频继续播）或走默认的关闭流程
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if close_to_tray && tray_ready {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                // 最小化也可以收进托盘（只留托盘图标与播放）
                tauri::WindowEvent::Resized(_) => {
                    if minimize_to_tray && tray_ready && window.is_minimized().unwrap_or(false) {
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![commands::ipc])
        .run(tauri::generate_context!())
        .expect("启动 QQ 音乐 Lite 失败");
}
