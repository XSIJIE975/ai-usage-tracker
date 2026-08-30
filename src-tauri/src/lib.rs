use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

mod commands;
mod db;
mod vault;

use db::Db;
use vault::{KeyringKeyStore, Vault};

pub struct AppState {
    pub vault: Mutex<Vault>,
    pub db: Mutex<Db>,
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
            app.manage(AppState {
                vault: Mutex::new(vault),
                db: Mutex::new(db),
            });

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
            commands::save_snapshot,
            commands::get_latest_snapshots,
            commands::list_snapshots,
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
            commands::quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI Usage Tracker");
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开主窗口", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "显示快速面板", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quick, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
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

fn toggle_quick(app: &AppHandle) {
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
