use std::sync::Mutex;
use std::time::Instant;

use serde_json::Value;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

mod autostart;
mod commands;
mod db;
mod instances;
mod tray_scheme;
mod vault;

use db::Db;
use vault::{KeyringKeyStore, Vault};

pub struct AppState {
    pub vault: Mutex<Vault>,
    pub db: Mutex<Db>,
    /// 当前注册的快速面板全局快捷键（规范格式，如 "Alt+KeyU"）
    pub quick_shortcut: Mutex<Option<String>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 自启静默启动标记（ADR-0015）：仅自启路径携带，手动启动与更新后重启一律显示主窗口
    let silent_launch = autostart::launched_silently();
    tauri::Builder::default()
        // 单实例插件必须最先注册：第二实例启动时立即退出，并由回调唤起已有主窗口
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
                let _ = main.unminimize();
                let _ = main.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;
            let db = Db::open(&app_data.join("ai-usage-tracker.db"))?;
            let keystore = KeyringKeyStore::new(app.config().identifier.clone());
            let mut vault = Vault::new(app_data.join("vault.json"), Box::new(keystore));
            if let Err(error) = vault.open() {
                eprintln!("Credential Vault 打开失败：{error}");
            }
            // 静默的一次性迁移：扁平凭据 → 供应商实例（幂等；vault 未解锁时由 vault_migrate 补跑）
            if let Err(error) = instances::migrate_to_instances(&mut vault, &db) {
                eprintln!("供应商实例迁移失败：{error}");
            }
            app.manage(AppState {
                vault: Mutex::new(vault),
                db: Mutex::new(db),
                quick_shortcut: Mutex::new(None),
            });
            // 托盘呈现状态（图标方案/计量快照/语言）独立于 AppState，由 tray_scheme 模块消费
            app.manage(tray_scheme::TrayState::default());

            // 注册设置中配置的快速面板全局快捷键；失败不阻断启动
            let app_state = app.state::<AppState>();
            // 读设置失败必须可见（ADR-0024）：静默跳过会让快捷键/自启重放/窗口标题
            // 全部失效且无任何痕迹，用户只会觉得「设置丢了」
            let settings = match app_state.db.lock().expect("db lock poisoned").get_settings() {
                Ok(settings) => Some(settings),
                Err(error) => {
                    eprintln!("启动读取设置失败，跳过窗口标题/快捷键注册/自启重放：{error}");
                    None
                }
            };
            // 托盘初始语言取落库设置（ADR-0024）：en 用户启动即见英文托盘菜单，
            // 不必等 webview 加载后的 refresh_tray_menu 来纠正
            let language = settings
                .as_ref()
                .and_then(|value| value.get("interfaceLanguage").and_then(Value::as_str))
                .unwrap_or("")
                .to_string();
            *app.state::<tray_scheme::TrayState>()
                .language
                .lock()
                .expect("tray language lock poisoned") = language.clone();
            if let Some(settings) = settings {
                // 窗口标题统一走 app_title（内含开发实例 (dev) 后缀，ADR-0018）；
                // 语言切换后 refresh_tray_menu 会用同一函数重放，两处不可再各写一套
                let title = commands::app_title(&language);
                for label in ["main", "quick", "glance"] {
                    if let Some(window) = app.get_webview_window(label) {
                        let _ = window.set_title(&title);
                    }
                }
                if let Some(shortcut) = settings.get("quickPanelShortcut").and_then(Value::as_str) {
                    if !shortcut.is_empty() {
                        if let Err(error) = commands::apply_quick_shortcut(app.handle(), shortcut.to_string()) {
                            eprintln!("注册快速面板快捷键失败：{error}");
                            // 占用/冲突在启动期无内联界面可提示（ADR-0018）：发系统通知告知用户
                            commands::notify_quick_shortcut_failure(app.handle(), &language, shortcut);
                        }
                    }
                }
                // 已开启自启时幂等重放一次注册：顺带修正安装路径变化；失败不阻断启动
                if settings.get("autoStart").and_then(Value::as_bool).unwrap_or(false) {
                    let silent_start = settings.get("silentStart").and_then(Value::as_bool).unwrap_or(false);
                    if let Err(error) = autostart::apply(app.handle(), true, silent_start) {
                        eprintln!("刷新开机自启注册失败：{error}");
                    }
                }
            }

            // 主窗口默认 visible: false，由启动方式决定是否显示（自启静默启动保持隐藏）
            if !silent_launch {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.show();
                    let _ = main.set_focus();
                }
            }

            // 隐藏工具窗口是纯优化性操作（两个窗口本就默认隐藏），失败记日志后继续（ADR-0024）：
            // 不该让一次窗口操作失败阻断 setup、连托盘都建不起来
            if let Some(quick) = app.get_webview_window("quick") {
                if let Err(error) = quick.hide() {
                    eprintln!("隐藏快速面板窗口失败：{error}");
                }
            }
            if let Some(glance) = app.get_webview_window("glance") {
                if let Err(error) = glance.hide() {
                    eprintln!("隐藏速览面板窗口失败：{error}");
                }
            }

            // release 加固（ADR-0026）：发布版关闭页面重载加速键、右键菜单与 devtools；
            // dev 构建保留（HMR 与调试依赖）。Windows 在 WebView2 设置层权威关闭，
            // macOS/Linux 的右键菜单由前端 PROD 拦截兜底（src/main.tsx）
            if !cfg!(debug_assertions) {
                harden_release_webviews(app.handle());
            }

            setup_tray(app.handle(), &language)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                // DPI 变化后用量环需按新档位重绘（ADR-0016）。
                // 只认主窗口：图标尺寸取自主窗口的缩放档位（tray_scheme::apply 内读 main 的
                // scale_factor），面板窗口的缩放变化对托盘没有意义，不该触发重绘（ADR-0019）
                tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    if window.label() == "main" {
                        tray_scheme::apply(window.app_handle());
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_status,
            commands::vault_migrate,
            commands::vault_save_credentials,
            commands::vault_credentials,
            commands::vault_credential_status,
            commands::get_settings,
            commands::save_settings,
            commands::list_instances,
            commands::create_instance,
            commands::update_instance,
            commands::reorder_instances,
            commands::delete_instance,
            commands::save_snapshot,
            commands::get_latest_snapshots,
            tray_scheme::set_tray_icon_scheme,
            tray_scheme::update_tray_meter,
            commands::add_notification,
            commands::list_alert_states,
            commands::save_alert_states,
            commands::list_notifications,
            commands::unread_notification_count,
            commands::mark_all_notifications_read,
            commands::delete_notification,
            commands::clear_notifications,
            commands::provider_request,
            commands::open_main_window,
            commands::hide_quick_window,
            commands::toggle_quick_window,
            commands::hide_glance_window,
            commands::register_quick_shortcut,
            commands::refresh_tray_menu,
            autostart::set_autostart,
            commands::diagnose_request,
            commands::quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI Usage Tracker");
}

fn build_tray_menu(app: &AppHandle, lang: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let en = lang == "en";
    let open = MenuItem::with_id(app, "open", if en { "Open main window" } else { "打开主窗口" }, true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", if en { "Show quick panel" } else { "显示快速面板" }, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", if en { "Quit" } else { "退出" }, true, None::<&str>)?;
    Menu::with_items(app, &[&open, &quick, &quit])
}

/// release 加固（ADR-0026）：对全部 webview 关闭 WebView2 的浏览器级加速键
/// （F5/Ctrl+R 重载、F12 devtools）与默认右键菜单。仅 Windows 有该设置层；
/// 失败只记日志——加固失败回退到 WebView2 默认行为，不该崩掉启动。
#[cfg(windows)]
fn harden_release_webviews(app: &AppHandle) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    for (label, window) in app.webview_windows() {
        let closure_label = label.clone();
        let result = window.with_webview(move |webview| unsafe {
            let label = &closure_label;
            let controller = webview.controller();
            let core = match controller.CoreWebView2() {
                Ok(core) => core,
                Err(error) => {
                    eprintln!("窗口 {label} 获取 WebView2 句柄失败：{error}");
                    return;
                }
            };
            if let Err(error) = core.Settings().and_then(|settings| {
                // 加速键开关在 Settings3（WebView2 SDK 1.0.774+），基础接口没有；cast 失败 = 运行时过旧，跳过该项
                settings
                    .cast::<ICoreWebView2Settings3>()?
                    .SetAreBrowserAcceleratorKeysEnabled(false.into())?;
                settings.SetAreDefaultContextMenusEnabled(false.into())?;
                settings.SetAreDevToolsEnabled(false.into())?;
                Ok(())
            }) {
                eprintln!("窗口 {label} 的 release 加固失败：{error}");
            }
        });
        if let Err(error) = result {
            eprintln!("窗口 {label} 调度加固任务失败：{error}");
        }
    }
}

/// 非 Windows 无 WebView2 设置层：右键菜单等由前端 PROD 拦截兜底（ADR-0026）
#[cfg(not(windows))]
fn harden_release_webviews(_app: &AppHandle) {}

fn setup_tray(app: &AppHandle, language: &str) -> tauri::Result<()> {
    let menu = build_tray_menu(app, language)?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip(commands::tray_tooltip(language, false))
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => open_main(app),
            "quick" => toggle_quick(app),
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击弹出速览面板（ADR-0016）；快速面板收敛为快捷键与右键菜单唤起
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                position,
                rect,
                ..
            } = event
            {
                let app = tray.app_handle();
                let scale = app
                    .get_webview_window("main")
                    .and_then(|window| window.scale_factor().ok())
                    .unwrap_or(1.0);
                // 光标位置本就是物理像素；图标矩形是 tauri::Position/Size 枚举，需转物理值
                let icon = rect.position.to_physical(scale);
                let icon_size = rect.size.to_physical(scale);
                toggle_glance(
                    app,
                    Some((position.x, position.y, icon.x, icon.y, icon_size.width, icon_size.height)),
                );
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

fn open_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn toggle_quick(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("quick") {
        let visible = window.is_visible().unwrap_or(false);
        if visible {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.emit("quick-shown", ());
            let _ = window.set_focus();
        }
    }
}

/// 托盘左键单击：弹出速览面板并锚定到托盘图标旁（ADR-0016）。
/// 再点一次收起；刚被失焦自动隐藏（300ms 内）时视为同一交互，不重新弹出——
/// 面板失焦（光标在托盘上）与本次托盘单击是先后到达的两个事件，不挡会表现为「点了收不起来」。
pub fn toggle_glance(app: &AppHandle, anchor: Option<(f64, f64, f64, f64, f64, f64)>) {
    let Some(window) = app.get_webview_window("glance") else {
        return;
    };
    let state = app.state::<tray_scheme::TrayState>();
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        record_glance_hidden(app);
        return;
    }
    if let Some(hidden_at) = *state.glance_hidden_at.lock().expect("glance hidden lock poisoned") {
        if hidden_at.elapsed() < tray_scheme::GLANCE_RESHOW_GUARD {
            return;
        }
    }
    if let Some((cursor_x, cursor_y, icon_x, icon_y, icon_w, icon_h)) = anchor {
        if let Some(position) =
            tray_scheme::anchor_position(&window, (cursor_x, cursor_y), (icon_x, icon_y, icon_w, icon_h))
        {
            let _ = window.set_position(position);
        }
    }
    let _ = window.show();
    let _ = window.emit("glance-shown", ());
    let _ = window.set_focus();
}

fn record_glance_hidden(app: &AppHandle) {
    let state = app.state::<tray_scheme::TrayState>();
    *state.glance_hidden_at.lock().expect("glance hidden lock poisoned") = Some(Instant::now());
}
