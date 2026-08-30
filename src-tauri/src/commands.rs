use std::collections::HashMap;

use reqwest::Method;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{db, AppState};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatusResponse {
    pub initialized: bool,
    pub unlocked: bool,
    pub needs_migration: bool,
    pub keychain_lost: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub deepseek_api_key: bool,
    pub deepseek_user_token: bool,
    pub opencode_go_workspace_id: bool,
    pub opencode_go_auth_cookie: bool,
    pub opencode_go_api_key: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultCredentials {
    pub deepseek_api_key: Option<String>,
    pub deepseek_user_token: Option<String>,
    pub opencode_go_workspace_id: Option<String>,
    pub opencode_go_auth_cookie: Option<String>,
    pub opencode_go_api_key: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body_text: String,
}

#[tauri::command]
pub fn vault_status(state: State<'_, AppState>) -> VaultStatusResponse {
    let vault = state.vault.lock().expect("vault lock poisoned");
    let status = vault.state();
    VaultStatusResponse {
        initialized: status.initialized,
        unlocked: status.unlocked,
        needs_migration: status.needs_migration,
        keychain_lost: status.keychain_lost,
    }
}

#[tauri::command]
pub fn vault_migrate(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> Result<(), String> {
    {
        let mut vault = state.vault.lock().expect("vault lock poisoned");
        vault.migrate(&password)?;
    }
    let _ = app.emit("vault-status-changed", ());
    let _ = app.emit("credentials-changed", ());
    Ok(())
}

#[tauri::command]
pub fn vault_save_credentials(
    app: AppHandle,
    state: State<'_, AppState>,
    credentials: Value,
) -> Result<(), String> {
    let mut vault = state.vault.lock().expect("vault lock poisoned");
    vault.ensure_unlocked()?;
    let mut current = vault.credentials()?.clone();
    let current_object = current
        .as_object_mut()
        .ok_or_else(|| "Credential Vault 数据格式错误".to_string())?;
    if let Some(input) = credentials.as_object() {
        apply_credentials(current_object, input);
    }
    vault.save_credentials(&current)?;
    drop(vault);
    let _ = app.emit("vault-status-changed", ());
    let _ = app.emit("credentials-changed", ());
    Ok(())
}

fn apply_credentials(
    current: &mut serde_json::Map<String, Value>,
    input: &serde_json::Map<String, Value>,
) {
    for (key, value) in input {
        if value.is_null() {
            current.remove(key);
        } else {
            current.insert(key.clone(), value.clone());
        }
    }
}

#[tauri::command]
pub fn vault_credentials(state: State<'_, AppState>) -> Result<VaultCredentials, String> {
    let vault = state.vault.lock().expect("vault lock poisoned");
    if !vault.is_unlocked() {
        return Err("Credential Vault 未解锁".to_string());
    }
    let credentials = vault.credentials()?;
    Ok(VaultCredentials {
        deepseek_api_key: credential_text(credentials, "deepseekApiKey"),
        deepseek_user_token: credential_text(credentials, "deepseekUserToken"),
        opencode_go_workspace_id: credential_text(credentials, "opencodeGoWorkspaceId"),
        opencode_go_auth_cookie: credential_text(credentials, "opencodeGoAuthCookie"),
        opencode_go_api_key: credential_text(credentials, "opencodeGoApiKey"),
    })
}

#[tauri::command]
pub fn vault_credential_status(state: State<'_, AppState>) -> Result<CredentialStatus, String> {
    let vault = state.vault.lock().expect("vault lock poisoned");
    if !vault.is_unlocked() {
        return Ok(CredentialStatus {
            deepseek_api_key: false,
            deepseek_user_token: false,
            opencode_go_workspace_id: false,
            opencode_go_auth_cookie: false,
            opencode_go_api_key: false,
        });
    }
    let credentials = vault.credentials()?;
    Ok(CredentialStatus {
        deepseek_api_key: has_text(credentials, "deepseekApiKey"),
        deepseek_user_token: has_text(credentials, "deepseekUserToken"),
        opencode_go_workspace_id: has_text(credentials, "opencodeGoWorkspaceId"),
        opencode_go_auth_cookie: has_text(credentials, "opencodeGoAuthCookie"),
        opencode_go_api_key: has_text(credentials, "opencodeGoApiKey"),
    })
}

fn has_text(value: &Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(|text| !text.is_empty())
        .unwrap_or(false)
}

fn credential_text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

fn normalize_auth_cookie(value: &str) -> String {
    let mut cookie = value.trim();
    if cookie.to_ascii_lowercase().starts_with("cookie:") {
        cookie = cookie["cookie:".len()..].trim();
    }

    if cookie.contains(';') {
        for part in cookie.split(';') {
            if let Some((name, rest)) = part.trim().split_once('=') {
                if name.trim().eq_ignore_ascii_case("auth") {
                    return rest.trim().to_string();
                }
            }
        }
    }

    if cookie
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("auth="))
    {
        return cookie[5..].trim().to_string();
    }

    cookie.to_string()
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Value, String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.get_settings()
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Value) -> Result<(), String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.save_settings(&settings)
}

#[tauri::command]
pub fn save_snapshot(
    state: State<'_, AppState>,
    provider_id: String,
    payload: Value,
) -> Result<(), String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.save_snapshot(&provider_id, &payload)
}

#[tauri::command]
pub fn get_latest_snapshots(state: State<'_, AppState>) -> Result<Vec<db::StoredSnapshot>, String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.get_latest_snapshots()
}

#[tauri::command]
pub fn list_snapshots(
    state: State<'_, AppState>,
    provider_id: String,
    since_ms: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<db::StoredSnapshot>, String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.list_snapshots(&provider_id, since_ms.unwrap_or(0), limit.unwrap_or(2000))
}

/// 在默认托盘图标的右下角合成红点徽章，生成告警态托盘图标（无需额外图标资产）
fn alert_tray_icon(default_icon: &tauri::image::Image<'_>) -> tauri::image::Image<'static> {
    let mut rgba = default_icon.rgba().to_vec();
    let width = default_icon.width() as i32;
    let height = default_icon.height() as i32;
    let center_x = width - 10;
    let center_y = height - 10;
    let radius = 8;
    for y in (center_y - radius - 1).max(0)..=(center_y + radius + 1).min(height - 1) {
        for x in (center_x - radius - 1).max(0)..=(center_x + radius + 1).min(width - 1) {
            let dx = x - center_x;
            let dy = y - center_y;
            let dist2 = dx * dx + dy * dy;
            let index = ((y as usize) * (width as usize) + (x as usize)) * 4;
            if dist2 <= (radius - 2) * (radius - 2) {
                rgba[index] = 220;
                rgba[index + 1] = 38;
                rgba[index + 2] = 38;
                rgba[index + 3] = 255;
            } else if dist2 <= radius * radius {
                rgba[index] = 255;
                rgba[index + 1] = 255;
                rgba[index + 2] = 255;
                rgba[index + 3] = 255;
            }
        }
    }
    tauri::image::Image::new_owned(rgba, width as u32, height as u32)
}

#[tauri::command]
pub fn set_tray_alert(app: AppHandle, active: bool) -> Result<(), String> {
    let tray = app
        .tray_by_id("main-tray")
        .ok_or_else(|| "托盘未初始化".to_string())?;
    if active {
        let default_icon = app
            .default_window_icon()
            .ok_or_else(|| "缺少默认图标".to_string())?;
        tray.set_icon(Some(alert_tray_icon(default_icon)))
            .map_err(|error| error.to_string())?;
        tray.set_tooltip(Some("AI 用量助手 — 有额度告警"))
            .map_err(|error| error.to_string())?;
    } else {
        if let Some(icon) = app.default_window_icon().cloned() {
            tray.set_icon(Some(icon)).map_err(|error| error.to_string())?;
        }
        tray.set_tooltip(Some("AI 用量助手"))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

// ─── 全局快捷键 ───

/// 注册快速面板全局快捷键（注销旧组合）。空字符串表示不启用。
/// 注册失败通常意味着组合被其他程序占用（无法识别具体占用者）。
pub fn apply_quick_shortcut(app: &AppHandle, shortcut: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let state = app.state::<AppState>();
    {
        let mut current = state.quick_shortcut.lock().expect("quick_shortcut lock poisoned");
        if current.as_deref() == Some(shortcut.as_str()) {
            return Ok(());
        }
        if let Some(previous) = current.take() {
            let _ = app.global_shortcut().unregister(previous.as_str());
        }
        if shortcut.is_empty() {
            return Ok(());
        }
        app.global_shortcut()
            .on_shortcut(shortcut.as_str(), |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    crate::toggle_quick(app);
                }
            })
            .map_err(|error| format!("快捷键注册失败，可能与其他程序冲突：{error}"))?;
        *current = Some(shortcut);
    }
    Ok(())
}

#[tauri::command]
pub fn register_quick_shortcut(app: AppHandle, shortcut: String) -> Result<(), String> {
    apply_quick_shortcut(&app, shortcut)
}

// ─── 连通性诊断 ───

#[derive(Serialize)]
pub struct DiagnosisResult {
    pub ok: bool,
    pub status: u16,
    pub latency_ms: u64,
    pub message: String,
}

/// 用"刚输入、尚未保存"的凭据值发起一次真实探测请求，验证连通性。
/// auth: "bearer"（携带 credential 作为 Bearer token）| "cookie"（auth=<normalized credential>）
#[tauri::command]
pub async fn diagnose_request(
    url: String,
    auth: Option<String>,
    credential: Option<String>,
    expect_html: Option<bool>,
) -> Result<DiagnosisResult, String> {
    let client = reqwest::Client::builder()
        .user_agent("AI Usage Tracker/0.1.0")
        .build()
        .map_err(|error| error.to_string())?;

    let mut request = client.request(Method::GET, &url);
    match auth.as_deref() {
        Some("bearer") => {
            let key = credential
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "请先填写凭据值".to_string())?;
            let key = key.trim();
            request = request.header("Authorization", format!("Bearer {key}"));
        }
        Some("cookie") => {
            let cookie = credential
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "请先填写凭据值".to_string())?;
            let normalized = normalize_auth_cookie(&cookie);
            request = request.header("Cookie", format!("auth={normalized}"));
            request = request.header(
                "User-Agent",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0",
            );
        }
        _ => {}
    }

    let started = std::time::Instant::now();
    let response = request.send().await;
    let latency_ms = started.elapsed().as_millis() as u64;

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            return Ok(DiagnosisResult {
                ok: false,
                status: 0,
                latency_ms,
                message: format!("网络请求失败：{error}"),
            });
        }
    };

    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();

    let (ok, message) = if status == 200 {
        if expect_html == Some(true) && body.contains("openauth") {
            (false, "Cookie 已失效（页面跳转到登录）".to_string())
        } else {
            (true, format!("连接正常（{latency_ms}ms）"))
        }
    } else if status == 401 || status == 403 {
        (false, format!("凭据无效或已过期（HTTP {status}）"))
    } else {
        (false, format!("接口返回 HTTP {status}"))
    };

    Ok(DiagnosisResult {
        ok,
        status,
        latency_ms,
        message,
    })
}

/// 按界面语言重建托盘右键菜单（zh/en）；菜单事件处理在托盘创建时已注册，重建菜单不影响
#[tauri::command]
pub fn refresh_tray_menu(app: AppHandle, language: String) -> Result<(), String> {
    let tray = app
        .tray_by_id("main-tray")
        .ok_or_else(|| "托盘未初始化".to_string())?;
    let menu = crate::build_tray_menu(&app, &language).map_err(|error| error.to_string())?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())
}

// ─── 通知 ───

#[tauri::command]
pub fn add_notification(
    state: State<'_, AppState>,
    provider_id: String,
    title: String,
    body: String,
) -> Result<db::StoredNotification, String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.add_notification(&provider_id, &title, &body)
}

#[tauri::command]
pub fn list_notifications(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<db::StoredNotification>, String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.list_notifications(limit.unwrap_or(200))
}

#[tauri::command]
pub fn unread_notification_count(state: State<'_, AppState>) -> Result<i64, String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.unread_notification_count()
}

#[tauri::command]
pub fn mark_all_notifications_read(state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.mark_all_notifications_read()
}

#[tauri::command]
pub fn delete_notification(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.delete_notification(id)
}

#[tauri::command]
pub fn clear_notifications(state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.clear_notifications()
}

#[tauri::command]
pub async fn provider_request(
    state: State<'_, AppState>,
    provider_id: String,
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body_text: Option<String>,
    auth: Option<String>,
) -> Result<ProviderResponse, String> {
    let credentials = {
        let vault = state.vault.lock().expect("vault lock poisoned");
        vault.credentials()?.clone()
    };

    let client = reqwest::Client::builder()
        .user_agent("AI Usage Tracker/0.1.0")
        .build()
        .map_err(|error| error.to_string())?;

    let method = match method.as_deref().unwrap_or("GET") {
        "POST" => Method::POST,
        _ => Method::GET,
    };
    let mut request = client.request(method, &url);
    let mut headers = headers.unwrap_or_default();

    match auth.as_deref() {
        Some("bearer") => {
            let key = match provider_id.as_str() {
                "deepseek" => credentials
                    .get("deepseekApiKey")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "缺少 DeepSeek API Key".to_string())?,
                "deepseek-platform" => credentials
                    .get("deepseekUserToken")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "缺少 DeepSeek UserToken".to_string())?,
                "opencode-go" => credentials
                    .get("opencodeGoApiKey")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "缺少 OpenCode Go API Key".to_string())?,
                _ => return Err("不支持的 provider bearer auth".to_string()),
            };
            headers.insert("Authorization".to_string(), format!("Bearer {key}"));
        }
        Some("cookie") if provider_id == "opencode-go" => {
            let cookie = credentials
                .get("opencodeGoAuthCookie")
                .and_then(Value::as_str)
                .ok_or_else(|| "缺少 OpenCode Auth Cookie".to_string())?;
            let normalized = normalize_auth_cookie(cookie);
            headers.insert("Cookie".to_string(), format!("auth={normalized}"));
            headers
                .entry("User-Agent".to_string())
                .or_insert_with(|| {
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0"
                        .to_string()
                });
        }
        Some("cookie") => return Err("不支持的 provider cookie auth".to_string()),
        _ => {}
    }

    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(body) = body_text {
        request = request.body(body);
    }

    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let response_headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                value.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect::<HashMap<_, _>>();
    let body_text = response.text().await.map_err(|error| error.to_string())?;

    Ok(ProviderResponse {
        status,
        headers: response_headers,
        body_text,
    })
}

#[tauri::command]
pub fn open_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn hide_quick_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("quick") {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn toggle_quick_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("quick") {
        if window.is_visible().map_err(|error| error.to_string())? {
            window.hide().map_err(|error| error.to_string())?;
        } else {
            window.show().map_err(|error| error.to_string())?;
            window
                .emit("quick-shown", ())
                .map_err(|error| error.to_string())?;
            let _ = window.set_focus();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn quit_app(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_response_uses_camel_case_field_names() {
        let value = serde_json::to_value(ProviderResponse {
            status: 200,
            headers: HashMap::new(),
            body_text: "ok".to_string(),
        })
        .expect("provider response should serialize");
        assert_eq!(value["status"], 200);
        assert_eq!(value["bodyText"], "ok");
    }

    #[test]
    fn normalizes_opencode_go_auth_cookie_inputs() {
        assert_eq!(normalize_auth_cookie(" abc "), "abc");
        assert_eq!(normalize_auth_cookie("auth=abc"), "abc");
        assert_eq!(normalize_auth_cookie("AUTH=abc"), "abc");
        assert_eq!(normalize_auth_cookie("Cookie: auth=abc"), "abc");
        assert_eq!(normalize_auth_cookie("foo=1; auth=abc; bar=2"), "abc");
    }

    #[test]
    fn credential_payloads_expose_deepseek_user_token_field() {
        let status = serde_json::to_value(CredentialStatus {
            deepseek_api_key: true,
            deepseek_user_token: false,
            opencode_go_workspace_id: false,
            opencode_go_auth_cookie: false,
            opencode_go_api_key: false,
        })
        .expect("credential status should serialize");
        assert_eq!(status["deepseekUserToken"], false);

        let credentials = serde_json::to_value(VaultCredentials {
            deepseek_api_key: None,
            deepseek_user_token: Some("token".to_string()),
            opencode_go_workspace_id: None,
            opencode_go_auth_cookie: None,
            opencode_go_api_key: None,
        })
        .expect("vault credentials should serialize");
        assert_eq!(credentials["deepseekUserToken"], "token");
    }

    #[test]
    fn applies_credential_updates_and_removes_null_keys() {
        let mut current = serde_json::json!({
            "deepseekApiKey": "sk-old",
            "opencodeGoWorkspaceId": "wrk-old"
        })
        .as_object_mut()
        .unwrap()
        .clone();
        let input = serde_json::json!({
            "deepseekApiKey": "sk-new",
            "opencodeGoWorkspaceId": null
        })
        .as_object()
        .unwrap()
        .clone();

        apply_credentials(&mut current, &input);

        assert_eq!(current["deepseekApiKey"], "sk-new");
        assert!(!current.contains_key("opencodeGoWorkspaceId"));
    }
}
