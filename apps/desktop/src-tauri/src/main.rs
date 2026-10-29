#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod commands;
mod cookies;
mod db;
mod error;
mod hash33;
mod models;
mod net;
mod qq_api;
mod secret;
mod state;

use tauri::Manager;

use crate::state::AppState;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let state = AppState::new(data_dir)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![commands::ipc])
        .run(tauri::generate_context!())
        .expect("启动 QQ 音乐 Lite 失败");
}
