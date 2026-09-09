use auto_launch::{AutoLaunch, AutoLaunchBuilder, WindowsEnableMode};
#[cfg(target_os = "macos")]
use auto_launch::MacOSLaunchMode;
use tauri::AppHandle;

/// 自启项携带的启动参数：仅自启路径生效的静默启动标记（ADR-0015）
pub const SILENT_FLAG: &str = "--silent";

/// 本次启动是否为自启静默启动（手动启动与更新后重启均不带该参数）
pub fn launched_silently() -> bool {
    std::env::args().any(|arg| arg == SILENT_FLAG)
}

/// 注册/取消开机自启。重复调用幂等：enable 以当前可执行路径与参数覆盖旧条目，
/// 因此启动时对已开启的设置重放一次 enable 可顺带修正安装路径变化。
/// debug 构建一律短路（ADR-0018）：debug exe 是 console 子系统且路径随构建漂移，
/// 注册它会覆盖安装版的同名 Run 值；disable 也拦，防止 dev 误删安装版的自启条目。
pub fn apply(app: &AppHandle, enabled: bool, silent: bool) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    let entry = build_entry(app, silent)?;
    if enabled {
        entry.enable().map_err(|error| format!("开启开机自启失败：{error}"))
    } else {
        entry.disable().map_err(|error| format!("关闭开机自启失败：{error}"))
    }
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool, silent: bool) -> Result<(), String> {
    apply(&app, enabled, silent)
}

fn build_entry(app: &AppHandle, silent: bool) -> Result<AutoLaunch, String> {
    let name = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| app.package_info().name.clone());
    let path = resolve_app_path()?.to_string_lossy().into_owned();
    let args: &[&str] = if silent { &[SILENT_FLAG] } else { &[] };

    let mut builder = AutoLaunchBuilder::new();
    builder
        .set_app_name(&name)
        .set_app_path(&path)
        // 每用户注册即可，与每用户安装器匹配；默认 Dynamic 会先试全系统注册（需管理员）
        .set_windows_enable_mode(WindowsEnableMode::CurrentUser)
        .set_args(args);
    #[cfg(target_os = "macos")]
    builder.set_macos_launch_mode(MacOSLaunchMode::LaunchAgent);
    builder
        .build()
        .map_err(|error| format!("构建自启项失败：{error}"))
}

/// macOS 的 LaunchAgent 需指向 .app 包而非包内二进制；其余平台用可执行文件自身
fn resolve_app_path() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("获取可执行文件路径失败：{error}"))?;
    #[cfg(target_os = "macos")]
    {
        // 可执行文件位于 <Bundle>.app/Contents/MacOS/ 内时，改指 .app 包根目录
        if let Some(contents) = exe.parent().and_then(|macos| macos.parent()) {
            if let Some(bundle) = contents.parent() {
                if contents.file_name().is_some_and(|name| name == "Contents")
                    && bundle.extension().is_some_and(|ext| ext == "app")
                {
                    return Ok(bundle.to_path_buf());
                }
            }
        }
    }
    Ok(exe)
}
