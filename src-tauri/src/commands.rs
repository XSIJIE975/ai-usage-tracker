use std::collections::HashMap;

use reqwest::Method;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{self, chrono_utc_now};
use crate::{instances, AppState};

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
        // 主密码迁移解锁后补跑实例迁移（启动时因 vault 未解锁被跳过的场景）
        let db = state.db.lock().expect("db lock poisoned");
        if let Err(error) = instances::migrate_to_instances(&mut vault, &db) {
            eprintln!("实例迁移失败：{error}");
        }
    }
    let _ = app.emit("vault-status-changed", ());
    let _ = app.emit("credentials-changed", ());
    Ok(())
}

#[tauri::command]
pub fn vault_save_credentials(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    credentials: Value,
) -> Result<(), String> {
    save_instance_credentials(state, &instance_id, &credentials)?;
    let _ = app.emit("vault-status-changed", ());
    let _ = app.emit("credentials-changed", ());
    Ok(())
}

/// 把 {slot: value|null} 合并进 vault.instances[instance_id]；null 删除槽位，空串跳过
fn save_instance_credentials(
    state: State<'_, AppState>,
    instance_id: &str,
    credentials: &Value,
) -> Result<(), String> {
    let mut vault = state.vault.lock().expect("vault lock poisoned");
    vault.ensure_unlocked()?;
    let mut current = vault.credentials()?.clone();
    let current_object = current
        .as_object_mut()
        .ok_or_else(|| "Credential Vault 数据格式错误".to_string())?;
    let instance_map = current_object
        .entry(instance_id.to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let instance_object = instance_map
        .as_object_mut()
        .ok_or_else(|| "Credential Vault 数据格式错误".to_string())?;
    if let Some(input) = credentials.as_object() {
        apply_credentials(instance_object, input);
    }
    vault.save_credentials(&current)
}

/// 把 {slot: value|null} 合并进单个实例的凭据 map：null 删除槽位、空白串跳过、其余 trim 后写入
fn apply_credentials(
    current: &mut serde_json::Map<String, Value>,
    input: &serde_json::Map<String, Value>,
) {
    for (key, value) in input {
        let normalized = match value.as_str() {
            Some(text) if text.trim().is_empty() => continue,
            Some(text) => Value::String(text.trim().to_string()),
            None => value.clone(),
        };
        if normalized.is_null() {
            current.remove(key);
        } else {
            current.insert(key.clone(), normalized);
        }
    }
}

/// 某实例已保存的凭据明文（仅非空值）：{slot: value}
#[tauri::command]
pub fn vault_credentials(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<HashMap<String, String>, String> {
    let vault = state.vault.lock().expect("vault lock poisoned");
    if !vault.is_unlocked() {
        return Err("Credential Vault 未解锁".to_string());
    }
    let credentials = vault.credentials()?;
    let instance = credentials.get(&instance_id);
    let mut result = HashMap::new();
    if let Some(object) = instance.and_then(Value::as_object) {
        for (slot, value) in object {
            if let Some(text) = credential_text(value) {
                result.insert(slot.clone(), text);
            }
        }
    }
    Ok(result)
}

/// 某实例的凭据配置状态：{slot: configured}；未解锁时一律未配置
#[tauri::command]
pub fn vault_credential_status(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<HashMap<String, bool>, String> {
    let vault = state.vault.lock().expect("vault lock poisoned");
    if !vault.is_unlocked() {
        return Ok(HashMap::new());
    }
    let credentials = vault.credentials()?;
    let instance = credentials.get(&instance_id);
    let mut result = HashMap::new();
    if let Some(object) = instance.and_then(Value::as_object) {
        for (slot, value) in object {
            result.insert(slot.clone(), credential_text(value).is_some());
        }
    }
    Ok(result)
}

fn credential_text(value: &Value) -> Option<String> {
    value
        .as_str()
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
    instance_id: String,
    payload: Value,
) -> Result<(), String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.save_snapshot(&instance_id, &payload)
}

#[tauri::command]
pub fn get_latest_snapshots(state: State<'_, AppState>) -> Result<Vec<db::StoredSnapshot>, String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.get_latest_snapshots()
}

// ─── 供应商实例 ───

#[tauri::command]
pub fn list_instances(state: State<'_, AppState>) -> Result<Vec<db::StoredInstance>, String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.list_instances()
}

#[tauri::command]
pub fn create_instance(
    app: AppHandle,
    state: State<'_, AppState>,
    provider_id: String,
    note: Option<String>,
    credentials: Option<Value>,
    auto_refresh: Option<bool>,
    threshold: Option<f64>,
) -> Result<db::StoredInstance, String> {
    if !instances::PROVIDER_KINDS
        .iter()
        .any(|(kind, _)| *kind == provider_id)
    {
        return Err(format!("不支持的供应商：{provider_id}"));
    }
    let instance = {
        let db = state.db.lock().expect("db lock poisoned");
        db::StoredInstance {
            id: uuid::Uuid::new_v4().to_string(),
            sort_order: db.next_sort_order()?,
            provider_id,
            note: note.unwrap_or_default(),
            pinned: false,
            auto_refresh: auto_refresh.unwrap_or(true),
            threshold,
            created_at: chrono_utc_now(),
        }
    };
    state
        .db
        .lock()
        .expect("db lock poisoned")
        .insert_instance(&instance, false)?;
    if let Some(credentials) = credentials {
        save_instance_credentials(state, &instance.id, &credentials)?;
    }
    let _ = app.emit("instances-changed", ());
    Ok(instance)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct InstancePatch {
    pub note: Option<String>,
    pub auto_refresh: Option<bool>,
    pub pinned: Option<bool>,
    /// 三层语义：缺省=不改、null=清除、数值=设置
    #[serde(deserialize_with = "deserialize_double_option")]
    pub threshold: Option<Option<f64>>,
}

/// serde 对 Option<Option<T>> 的 null 缺省行为是外层 None；
/// 显式 null 必须映射为 Some(None) 才能与「字段缺省」区分
fn deserialize_double_option<'de, D>(deserializer: D) -> Result<Option<Option<f64>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

#[tauri::command]
pub fn update_instance(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    patch: InstancePatch,
) -> Result<(), String> {
    {
        let db = state.db.lock().expect("db lock poisoned");
        db.update_instance(
            &id,
            patch.note.as_deref(),
            patch.auto_refresh,
            patch.pinned,
            patch.threshold,
        )?;
    }
    let _ = app.emit("instances-changed", ());
    Ok(())
}

#[tauri::command]
pub fn reorder_instances(
    app: AppHandle,
    state: State<'_, AppState>,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    {
        let db = state.db.lock().expect("db lock poisoned");
        db.reorder_instances(&ordered_ids)?;
    }
    let _ = app.emit("instances-changed", ());
    Ok(())
}

/// 删除实例：数据库侧事务清掉实例行 + 该实例快照 + 该实例通知；vault 侧移除其凭据
#[tauri::command]
pub fn delete_instance(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    {
        let db = state.db.lock().expect("db lock poisoned");
        db.delete_instance(&id)?;
    }
    {
        let mut vault = state.vault.lock().expect("vault lock poisoned");
        if vault.is_unlocked() {
            let cleanup = vault.credentials().map(|credentials| credentials.clone()).and_then(
                |mut current| {
                    let removed = current
                        .as_object_mut()
                        .and_then(|object| object.remove(&id));
                    match removed {
                        Some(_) => vault.save_credentials(&current),
                        None => Ok(()),
                    }
                },
            );
            if let Err(error) = cleanup {
                // 实例行已删：残留凭据不可见也无害，不因它让删除报错
                eprintln!("清理已删实例的凭据失败：{error}");
            }
        }
    }
    let _ = app.emit("instances-changed", ());
    let _ = app.emit("credentials-changed", ());
    Ok(())
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

/// 托盘悬停提示文案（zh/en × 常态/告警态）
pub fn tray_tooltip(language: &str, alert: bool) -> &'static str {
    match (language == "en", alert) {
        (false, false) => "AI 用量助手",
        (false, true) => "AI 用量助手 — 有额度告警",
        (true, false) => "AI Usage Tracker",
        (true, true) => "AI Usage Tracker — quota alert",
    }
}

/// 应用名（窗口标题与托盘提示共用，随界面语言）
pub fn app_title(language: &str) -> &'static str {
    if language == "en" {
        "AI Usage Tracker"
    } else {
        "AI 用量助手"
    }
}

#[tauri::command]
pub fn set_tray_alert(
    app: AppHandle,
    active: bool,
    language: Option<String>,
) -> Result<(), String> {
    let tray = app
        .tray_by_id("main-tray")
        .ok_or_else(|| "托盘未初始化".to_string())?;
    if active {
        let default_icon = app
            .default_window_icon()
            .ok_or_else(|| "缺少默认图标".to_string())?;
        tray.set_icon(Some(alert_tray_icon(default_icon)))
            .map_err(|error| error.to_string())?;
    } else if let Some(icon) = app.default_window_icon().cloned() {
        tray.set_icon(Some(icon)).map_err(|error| error.to_string())?;
    }
    tray.set_tooltip(Some(tray_tooltip(language.as_deref().unwrap_or("zh"), active)))
        .map_err(|error| error.to_string())?;
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
#[serde(rename_all = "camelCase")]
pub struct DiagnosisResult {
    pub ok: bool,
    pub status: u16,
    pub latency_ms: u64,
    /// 机器可读结果码，前端据此用界面语言组装文案（见 src/diagnostics.ts 的 describeDiagnosis）
    pub code: String,
    /// 附加细节（如网络错误的原始错误文本），可为空
    pub detail: Option<String>,
}

impl DiagnosisResult {
    fn new(ok: bool, status: u16, latency_ms: u64, code: &str, detail: Option<String>) -> Self {
        Self {
            ok,
            status,
            latency_ms,
            code: code.to_string(),
            detail,
        }
    }
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
            let key = match credential.filter(|value| !value.trim().is_empty()) {
                Some(key) => key,
                None => return Ok(DiagnosisResult::new(false, 0, 0, "missing-credential", None)),
            };
            let key = key.trim();
            request = request.header("Authorization", format!("Bearer {key}"));
        }
        Some("cookie") => {
            let cookie = match credential.filter(|value| !value.trim().is_empty()) {
                Some(cookie) => cookie,
                None => return Ok(DiagnosisResult::new(false, 0, 0, "missing-credential", None)),
            };
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
            return Ok(DiagnosisResult::new(
                false,
                0,
                latency_ms,
                "network-error",
                Some(error.to_string()),
            ));
        }
    };

    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();

    let (ok, code) = if status == 200 {
        if expect_html == Some(true) && body.contains("openauth") {
            (false, "login-redirect")
        } else {
            (true, "ok")
        }
    } else if status == 401 || status == 403 {
        (false, "invalid-credentials")
    } else {
        (false, "http-error")
    };

    Ok(DiagnosisResult::new(ok, status, latency_ms, code, None))
}

/// 按界面语言重建托盘右键菜单（zh/en）；菜单事件处理在托盘创建时已注册，重建菜单不影响。
/// 同时刷新托盘悬停提示与两个窗口的标题，使它们跟随界面语言。
#[tauri::command]
pub fn refresh_tray_menu(app: AppHandle, language: String) -> Result<(), String> {
    let tray = app
        .tray_by_id("main-tray")
        .ok_or_else(|| "托盘未初始化".to_string())?;
    let menu = crate::build_tray_menu(&app, &language).map_err(|error| error.to_string())?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())?;
    tray.set_tooltip(Some(tray_tooltip(&language, false)))
        .map_err(|error| error.to_string())?;
    let title = app_title(&language);
    for label in ["main", "quick"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.set_title(title);
        }
    }
    Ok(())
}

// ─── 通知 ───

#[tauri::command]
pub fn add_notification(
    state: State<'_, AppState>,
    instance_id: String,
    title: String,
    body: String,
) -> Result<db::StoredNotification, String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.add_notification(&instance_id, &title, &body)
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

/// bearer 凭据注入：由实例行查出种类，从 vault.instances[instanceId][slot] 取密钥
/// （空串视为未配置）。缺省槽位为各种类的主鉴权键（deepseek=apiKey、glm=planKey）。
fn resolve_bearer_key<'a>(kind: &str, slot: &str, credentials: &'a Value) -> Result<&'a str, String> {
    if let Some(value) = instances::instance_credential(credentials, slot) {
        return Ok(value);
    }
    match instances::credential_label(kind, slot) {
        Some(label) => Err(format!("缺少 {label}")),
        None => Err(format!("不支持的凭据槽位：{kind}/{slot}")),
    }
}

#[tauri::command]
pub async fn provider_request(
    state: State<'_, AppState>,
    instance_id: String,
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body_text: Option<String>,
    auth: Option<String>,
    credential_slot: Option<String>,
) -> Result<ProviderResponse, String> {
    let (kind, instance_credentials) = {
        let provider_id = {
            let db = state.db.lock().expect("db lock poisoned");
            db.get_instance(&instance_id)?
                .ok_or_else(|| "供应商实例不存在，请刷新后重试".to_string())?
                .provider_id
        };
        let vault = state.vault.lock().expect("vault lock poisoned");
        let credentials = vault.credentials()?.clone();
        (
            provider_id,
            credentials.get(&instance_id).cloned().unwrap_or(Value::Null),
        )
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
            let slot = match credential_slot.as_deref() {
                Some(slot) => slot.to_string(),
                None => instances::default_bearer_slot(&kind)
                    .ok_or_else(|| "不支持的 provider bearer auth".to_string())?
                    .to_string(),
            };
            let key = resolve_bearer_key(&kind, &slot, &instance_credentials)?;
            headers.insert("Authorization".to_string(), format!("Bearer {key}"));
        }
        Some("cookie") if kind == "opencode-go" => {
            let cookie = instances::instance_credential(&instance_credentials, "cookie")
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
    fn tray_tooltip_and_title_follow_language_and_alert_state() {
        assert_eq!(tray_tooltip("zh", false), "AI 用量助手");
        assert_eq!(tray_tooltip("zh", true), "AI 用量助手 — 有额度告警");
        assert_eq!(tray_tooltip("en", false), "AI Usage Tracker");
        assert_eq!(tray_tooltip("en", true), "AI Usage Tracker — quota alert");
        assert_eq!(app_title("zh"), "AI 用量助手");
        assert_eq!(app_title("en"), "AI Usage Tracker");
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
    fn instance_patch_deserializes_threshold_semantics() {
        let absent: InstancePatch = serde_json::from_str(r#"{"note":"x"}"#).unwrap();
        assert!(absent.threshold.is_none());

        let cleared: InstancePatch = serde_json::from_str(r#"{"threshold":null}"#).unwrap();
        assert_eq!(cleared.threshold, Some(None));

        let set: InstancePatch = serde_json::from_str(r#"{"threshold":42}"#).unwrap();
        assert_eq!(set.threshold, Some(Some(42.0)));
    }

    #[test]
    fn resolves_bearer_keys_by_kind_and_slot() {
        let creds = serde_json::json!({
            "deepseek": { "apiKey": "sk-1", "userToken": "tok-1" },
            "opencode-go": { "apiKey": "oc-1", "cookie": "cookie-1" },
            "glm": { "planKey": "plan" }
        });
        let deepseek = &creds["deepseek"];
        assert_eq!(resolve_bearer_key("deepseek", "apiKey", deepseek).unwrap(), "sk-1");
        assert_eq!(resolve_bearer_key("deepseek", "userToken", deepseek).unwrap(), "tok-1");
        assert_eq!(
            resolve_bearer_key("opencode-go", "apiKey", &creds["opencode-go"]).unwrap(),
            "oc-1"
        );
        assert_eq!(resolve_bearer_key("glm", "planKey", &creds["glm"]).unwrap(), "plan");
    }

    #[test]
    fn bearer_key_errors_name_the_missing_credential() {
        let empty = serde_json::json!({});
        assert!(resolve_bearer_key("glm", "planKey", &empty)
            .unwrap_err()
            .contains("Coding Plan API Key"));
        assert!(resolve_bearer_key("deepseek", "apiKey", &empty)
            .unwrap_err()
            .contains("DeepSeek API Key"));
        // 与 vault 侧语义一致：空串视为未配置
        let blank = serde_json::json!({ "planKey": "" });
        assert!(resolve_bearer_key("glm", "planKey", &blank).is_err());
        // 未知槽位组合直接拒绝，不落到「缺少」文案
        assert!(resolve_bearer_key("deepseek", "planKey", &empty)
            .unwrap_err()
            .contains("不支持的凭据槽位"));
    }

    #[test]
    fn applies_credential_updates_and_removes_null_keys() {
        let mut current = serde_json::json!({
            "apiKey": "sk-old",
            "workspaceId": "wrk-old"
        })
        .as_object_mut()
        .unwrap()
        .clone();
        let input = serde_json::json!({
            "apiKey": "sk-new",
            "workspaceId": null
        })
        .as_object()
        .unwrap()
        .clone();

        apply_credentials(&mut current, &input);

        assert_eq!(current["apiKey"], "sk-new");
        assert!(!current.contains_key("workspaceId"));
    }
}
