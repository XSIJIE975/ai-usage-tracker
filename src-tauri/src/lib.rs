use std::sync::Mutex;

use serde_json::Value;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

mod commands;
mod db;
mod instances;
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
        .setup(|app| {
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

            // 注册设置中配置的快速面板全局快捷键；失败不阻断启动
            let app_state = app.state::<AppState>();
            if let Ok(settings) = app_state.db.lock().expect("db lock poisoned").get_settings() {
                if let Some(shortcut) = settings.get("quickPanelShortcut").and_then(Value::as_str) {
                    if !shortcut.is_empty() {
                        if let Err(error) = commands::apply_quick_shortcut(app.handle(), shortcut.to_string()) {
                            eprintln!("注册快速面板快捷键失败：{error}");
                        }
                    }
                }
            }

            if let Some(quick) = app.get_webview_window("quick") {
                quick.hide()?;
            }

            setup_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
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
            commands::set_tray_alert,
            commands::add_notification,
            commands::list_notifications,
            commands::unread_notification_count,
            commands::mark_all_notifications_read,
            commands::delete_notification,
            commands::clear_notifications,
            commands::provider_request,
            commands::open_main_window,
            commands::hide_quick_window,
            commands::toggle_quick_window,
            commands::register_quick_shortcut,
            commands::refresh_tray_menu,
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

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_tray_menu(app, "zh")?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip(commands::tray_tooltip("zh", false))
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
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_quick(tray.app_handle());
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
