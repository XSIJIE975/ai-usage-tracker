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
