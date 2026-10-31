//! 原生「选择文件夹」对话框。
//!
//! 直接调用 Win32 的 `IFileOpenDialog`（`FOS_PICKFOLDERS`），不引入额外插件依赖，
//! 因此离线构建与现有 cargo 缓存都不受影响。调用方需把它放到主线程执行：
//! `AppHandle::run_on_main_thread`，模态循环阻塞的是界面线程而不是 tokio 线程。

use crate::error::PResult;

#[cfg(windows)]
pub fn pick_folder(owner: Option<isize>) -> PResult<Option<String>> {
    use windows::core::HRESULT;
    use windows::Win32::Foundation::S_OK;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};

    // 线程已按 MTA 初始化过：COM 可用，但配对关系不归我们管
    const RPC_E_CHANGED_MODE: HRESULT = HRESULT(0x8001_0106u32 as i32);

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        // S_FALSE 表示本线程此前已初始化，此时不能配对 CoUninitialize
        let owned = hr == S_OK;
        if hr.is_err() && hr != RPC_E_CHANGED_MODE {
            return Err(crate::error::PlatformError::msg(format!(
                "初始化 COM 失败：{hr:?}"
            )));
        }
        let outcome = show_dialog(owner);
        if owned {
            CoUninitialize();
        }
        outcome
    }
}

#[cfg(windows)]
unsafe fn show_dialog(owner: Option<isize>) -> PResult<Option<String>> {
    use windows::core::{HRESULT, IUnknown};
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, FILEOPENDIALOGOPTIONS, FOS_FORCEFILESYSTEM,
        FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
    };

    let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None::<&IUnknown>, CLSCTX_ALL)
        .map_err(|error| {
            crate::error::PlatformError::msg(format!("创建文件夹选择器失败：{error}"))
        })?;

    let options = FILEOPENDIALOGOPTIONS(
        FOS_PICKFOLDERS.0 | FOS_FORCEFILESYSTEM.0 | FOS_PATHMUSTEXIST.0,
    );
    dialog.SetOptions(options).map_err(|error| {
        crate::error::PlatformError::msg(format!("设置选择器选项失败：{error}"))
    })?;

    let hwnd = owner.map(|raw| HWND(raw as *mut core::ffi::c_void));
    if let Err(error) = dialog.Show(hwnd) {
        // 用户点了取消 / 直接关掉窗口
        if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
            return Ok(None);
        }
        return Err(crate::error::PlatformError::msg(format!(
            "文件夹选择器异常：{error}"
        )));
    }

    let item = dialog.GetResult().map_err(|error| {
        crate::error::PlatformError::msg(format!("读取选择结果失败：{error}"))
    })?;
    let raw = item.GetDisplayName(SIGDN_FILESYSPATH).map_err(|error| {
        crate::error::PlatformError::msg(format!("解析文件夹路径失败：{error}"))
    })?;
    let path = raw.to_string().ok();
    CoTaskMemFree(Some(raw.0 as *const core::ffi::c_void));
    Ok(path.filter(|value| !value.trim().is_empty()))
}

#[cfg(not(windows))]
pub fn pick_folder(_owner: Option<isize>) -> PResult<Option<String>> {
    Err(crate::error::PlatformError::msg(
        "当前平台暂不支持原生目录选择，请手动填写路径",
    ))
}
