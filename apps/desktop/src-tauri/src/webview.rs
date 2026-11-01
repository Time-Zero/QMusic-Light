//! Windows 上多 webview 的环境约束。
//!
//! 同一个 user data 目录下的所有 webview 共享一个 WebView2 浏览器进程，
//! WebView2 要求它们创建时的 **environment 选项逐字节一致**：
//! 只要有一个窗口的 `additionalBrowserArgs` 多了或少了，
//! 后创建的那个就会拿到 `ERROR_INVALID_STATE (0x8007139F)`
//! ——「组或资源的状态不是执行请求操作的正确状态」。
//!
//! 现场表现很有迷惑性：主界面一切正常，只有新窗口建不出来，
//! 报错看起来像 WebView2 运行时损坏，实际只是参数没对齐。
//!
//! 这份参数写在 `tauri.conf.json` 的主窗口里，所以程序化新建的浮窗一律照抄。

use tauri::{AppHandle, Runtime};

/// 主窗口在配置里声明的 `additionalBrowserArgs`。
///
/// 找不到主窗口配置（或这一项没写）时返回 `None`，此时保持 wry 的默认参数；
/// 只要所有程序化窗口都从这里取，彼此之间也仍然一致。
pub fn shared_args<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    app.config()
        .app
        .windows
        .iter()
        .find(|window| window.label == crate::tray::MAIN_WINDOW)
        .and_then(|window| window.additional_browser_args.clone())
}
