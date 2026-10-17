use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::Method;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{self, chrono_utc_now};
use crate::{instances, AppState};

/// 共享 HTTP 客户端（ADR-0024）：进程级单例，保留连接池与 keep-alive——
/// 之前每次调用重建 Client，自动刷新每轮都重新 TLS 握手。统一 10s 连接 / 30s 总超时：
/// 供应商挂起时超时错误走错误快照链路（ADR-0023），可见而不是把刷新无限挂死。
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("AI Usage Tracker/0.1.0")
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            // 只走 https：实测 reqwest 初始请求（client.rs 的 execute_request）与重定向
            // （redirect.rs 的 check）两处都校验方案，这里挡掉合法域被劫持成 http://
            // 跳转时的降级；目的地面本身在 instances::validate_request_url
            .https_only(true)
            .build()
            .expect("HTTP 客户端初始化失败")
    })
}

/// 网络失败的类别摘要：reqwest 外层 Display 只有 "error sending request for url (…)"，
/// 真实原因（超时/连接失败/传输中断）在错误链里被吞掉，用户无从判断该等服务还是查自己网络。
/// reqwest::Error 无公开构造器，类别判定抽成纯函数便于单测。
fn network_error_summary(is_timeout: bool, is_connect: bool, is_transfer: bool) -> &'static str {
    match (is_timeout, is_connect, is_transfer) {
        (true, true, _) => "连接超时（10 秒内未能建立连接）",
        (true, false, _) => "请求超时（30 秒内服务端未完成响应）",
        (false, true, _) => "连接失败（DNS 解析、TLS 或网络不可达）",
        (false, false, true) => "传输中断（连接被服务端或网络中途断开）",
        _ => "网络请求失败",
    }
}

/// 供应商网络请求失败 → 可读文案：类别摘要 + 底层原因链全文——摘要给人读，
/// 原因链留证据，分类失准时有链兜底，信息不被吞（ADR-0024 可见性）。
fn network_error_text(error: &reqwest::Error) -> String {
    let summary = network_error_summary(
        error.is_timeout(),
        error.is_connect(),
        error.is_body() || error.is_decode() || error.is_request(),
    );
    let mut chain = String::new();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        if !chain.is_empty() {
            chain.push_str(" ← ");
        }
        chain.push_str(&cause.to_string());
        source = cause.source();
    }
    if chain.is_empty() {
        format!("{summary}：{error}")
    } else {
        format!("{summary}：{chain}")
    }
}

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
        // 主密码迁移解锁后补跑凭据迁移（启动时因 vault 未解锁被跳过的场景）
        let db = state.db.lock().expect("db lock poisoned");
        if let Err(error) = instances::migrate_to_instances(&mut vault, &db) {
            eprintln!("凭据迁移失败：{error}");
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

/// Qoder 会话 Cookie 通道的缺省浏览器 UA（ADR-0030）：Qoder 网关不绑定登录时 UA
/// （CodexBar 硬编码 UA 实证），与 WorkBuddy 的逐字节同源校验截然不同。
/// 平台段随本机编译目标走、Chrome 版本串统一（CodexBar 实证可用的那个版本）：
/// UA 声称 Macintosh 而 TLS/HTTP2 指纹是本机 Windows，正是 Baxia 风控最容易识别的
/// 不自洽。版本升级时跟随 CodexBar 更新。调用方显式传 UA 时本值让位（or_insert）
#[cfg(target_os = "windows")]
pub const QODER_DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
#[cfg(target_os = "macos")]
pub const QODER_DEFAULT_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub const QODER_DEFAULT_UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

/// Qoder 登录态所在的 Cookie 名。凭据槽存的只是这个键的**值**，键名由这里的鉴权分支
/// 拼进 Cookie 头（与 WorkBuddy 的 session / session_2 同法：拼装口径不进前端）
const QODER_SESSION_COOKIE_NAME: &str = "qoder_session_cookie";

/// 小米 MiMo 会话通道的缺省浏览器 UA（ADR-0038）：与 Qoder 同形——网关不绑定登录时 UA
/// （CodexBar 硬编码 Chrome UA 实证），所以 UA 不占凭据格。平台段随本机编译目标走：
/// UA 声称 Macintosh 而 TLS 指纹是本机 Windows 是风控最容易识别的不自洽。版本串与
/// CodexBar 实证可用的那个对齐（Chrome/143），风控升级时跟随更新
#[cfg(target_os = "windows")]
pub const MIMO_DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
#[cfg(target_os = "macos")]
pub const MIMO_DEFAULT_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub const MIMO_DEFAULT_UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

/// 凭据相关头只允许由鉴权分支注入：调用方（渲染进程）传来的同名头一律剔除。
/// 排序挡不住这件事——reqwest 的 `RequestBuilder::header` 内部是 `HeaderMap::append`
/// （同名会并存两条，先到的那条被网关读到），所以「先铺静态头再注入凭据头」并不等于
/// 凭据赢；只有按名字过滤才能保证请求里只有一条、且值是 vault 里的。
const RESERVED_CREDENTIAL_HEADERS: [&str; 3] = ["cookie", "authorization", "user-agent"];

fn is_reserved_credential_header(name: &str) -> bool {
    RESERVED_CREDENTIAL_HEADERS
        .iter()
        .any(|reserved| name.eq_ignore_ascii_case(reserved))
}

/// Qoder 会话 Cookie 值的字节域（RFC 6265 cookie-value）：可见 ASCII，但排除空白、`"`、`,`、`;`。
/// 字符集与 `instances::validate_cookie_value`、前端 `providers/qoder.ts` 的
/// `isValidSessionCookieValue` 逐字符一致——三处任一处收紧都会误伤真机凭据。
/// 这一道同时挡住两类误输入：把整段 Cookie 头贴进来（带 `;` 与空格）、以及换行等头
/// 注入字符。前端保存与探测已过同口径白名单，这里兜住「vault 被外部改过」：否则 reqwest
/// 只在 `send()` 阶段抛一句没有指向的 builder 错误，用户看到的是"网络请求失败"而不是
/// "凭据里有非法字符"
fn validate_qoder_session_value(value: &str) -> Result<(), ()> {
    if value.is_empty() {
        return Err(());
    }
    if !instances::is_cookie_value_chars(value) {
        return Err(());
    }
    Ok(())
}

/// OpenCode 认的 Cookie 键：auth 覆盖旧页面与 /_server，__Host-console_session 覆盖新版控制台。
const OPENCODE_COOKIE_NAMES: [&str; 3] = ["auth", "__Host-auth", "__Host-console_session"];
/// 整段 Cookie 头的长度上限：正常登录态只有几百字节，超长基本是误贴了别的内容。
const MAX_OPENCODE_COOKIE_HEADER_LENGTH: usize = 8_192;

fn opencode_cookie_name(name: &str) -> Option<&'static str> {
    OPENCODE_COOKIE_NAMES
        .iter()
        .copied()
        .find(|allowed| allowed.eq_ignore_ascii_case(name))
}

/// 把用户粘贴的 OpenCode Cookie 输入归一化成可发送的 Cookie 头。
///
/// 兼容两种形态：裸值（没有 `=`）与整段 Cookie 头。裸值里 Iron Session 的 auth 值以
/// `Fe26.2` 开头，按 `auth=<value>` 处理；其余（控制台会话 `st_…`）按
/// `__Host-console_session=<value>` 处理。整段头只保留 auth / __Host-auth /
/// __Host-console_session，其余分析、语言等键丢弃。含换行或非法值字符一律拒绝，
/// 避免头注入。
fn opencode_cookie_header(value: &str) -> Result<String, String> {
    let mut cookie = value.trim();
    if cookie.to_ascii_lowercase().starts_with("cookie:") {
        cookie = cookie["cookie:".len()..].trim();
    }
    if cookie.is_empty() {
        return Err("缺少 OpenCode Cookie".to_string());
    }
    if cookie.len() > MAX_OPENCODE_COOKIE_HEADER_LENGTH {
        return Err("OpenCode Cookie 过长，请确认只粘贴了 Cookie 头".to_string());
    }
    // 裸值判定：没有 `=`，或 st_/Fe26.2 前缀且 `=` 只作为 base64 padding 出现在末尾。
    // 不能只按「有没有 =」判断——真实裸值可能带 `==` 填充。
    let first_eq = cookie.find('=');
    let bare_with_padding = first_eq.is_some_and(|idx| {
        !cookie.contains(';')
            && (cookie.starts_with("Fe26.2") || cookie.starts_with("st_"))
            && cookie[idx..].chars().all(|c| c == '=')
    });
    if first_eq.is_none() || bare_with_padding {
        if !instances::is_cookie_value_chars(cookie) {
            return Err(
                "OpenCode Cookie 值包含非法字符（不能带空格、引号、分号或控制符）".to_string(),
            );
        }
        let name = if cookie.starts_with("Fe26.2") {
            "auth"
        } else {
            "__Host-console_session"
        };
        return Ok(format!("{name}={cookie}"));
    }

    let mut parts: Vec<String> = Vec::new();
    let mut seen: Vec<&'static str> = Vec::new();
    for part in cookie.split(';') {
        let Some((raw_name, raw_value)) = part.trim().split_once('=') else {
            continue;
        };
        let Some(name) = opencode_cookie_name(raw_name.trim()) else {
            continue;
        };
        let value = raw_value.trim();
        if value.is_empty() || !instances::is_cookie_value_chars(value) {
            return Err(format!("OpenCode Cookie 的 {name} 值包含非法字符"));
        }
        if seen.contains(&name) {
            continue;
        }
        seen.push(name);
        parts.push(format!("{name}={value}"));
    }
    if parts.is_empty() {
        return Err("Cookie 里没有 auth 或 __Host-console_session".to_string());
    }
    Ok(parts.join("; "))
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
    balance_threshold: Option<f64>,
    site: Option<String>,
) -> Result<db::StoredInstance, String> {
    if !instances::PROVIDER_KINDS
        .iter()
        .any(|(kind, _)| *kind == provider_id)
    {
        return Err(format!("不支持的供应商：{provider_id}"));
    }
    if let Some(site) = site.as_deref() {
        instances::validate_site(site)?;
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
            balance_threshold,
            site: site.unwrap_or_else(|| "china".to_string()),
            token_auto_renew: true,
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
    #[serde(deserialize_with = "deserialize_double_option")]
    pub balance_threshold: Option<Option<f64>>,
    /// 站点（仅多站种类使用，ADR-0031）：缺省=不改；换站后原凭据跨登录域失效，需重贴/重扫
    pub site: Option<String>,
    /// token 自动续期开关（仅 workbuddy token 通道，ADR-0034）：缺省=不改
    pub token_auto_renew: Option<bool>,
}

/// serde 对 Option<Option<T>> 的 null 缺省行为是外层 None；
/// 显式 null 必须映射为 Some(None) 才能与「字段缺省」区分
fn deserialize_double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
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
    if let Some(site) = patch.site.as_deref() {
        instances::validate_site(site)?;
    }
    {
        let db = state.db.lock().expect("db lock poisoned");
        db.update_instance(
            &id,
            patch.note.as_deref(),
            patch.auto_refresh,
            patch.pinned,
            patch.threshold,
            patch.balance_threshold,
            patch.site.as_deref(),
            patch.token_auto_renew,
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
/// 开发实例标识后缀（ADR-0018）：窗口标题、托盘提示、应用名统一追加，
/// 与安装版并存运行时可即时分辨。后缀必须内聚在本模块的命名函数里——
/// 不要在调用侧自行拼接（refresh_tray_menu 重设窗口标题会把外部拼的后缀冲掉）。
pub fn dev_suffix() -> &'static str {
    if cfg!(debug_assertions) {
        " (dev)"
    } else {
        ""
    }
}

/// 托盘悬停提示文案（zh/en × 常态/告警态）
pub fn tray_tooltip(language: &str, alert: bool) -> String {
    let base = match (language == "en", alert) {
        (false, false) => "AI 用量助手",
        (false, true) => "AI 用量助手 — 有额度告警",
        (true, false) => "AI Usage Tracker",
        (true, true) => "AI Usage Tracker — quota alert",
    };
    format!("{base}{}", dev_suffix())
}

/// 应用名（窗口标题与托盘提示共用，随界面语言）
pub fn app_title(language: &str) -> String {
    if language == "en" {
        format!("AI Usage Tracker{}", dev_suffix())
    } else {
        format!("AI 用量助手{}", dev_suffix())
    }
}

// ─── 全局快捷键 ───

/// 注册快速面板全局快捷键（换绑语义）。空字符串表示不启用。
/// 注册失败通常意味着组合被其他程序占用（无法识别具体占用者）。
pub fn apply_quick_shortcut(app: &AppHandle, shortcut: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let state = app.state::<AppState>();
    let mut current = state.quick_shortcut.lock().expect("quick_shortcut lock poisoned");
    if current.as_deref() == Some(shortcut.as_str()) {
        return Ok(());
    }
    if shortcut.is_empty() {
        // 清空快捷键：注销旧组合即可；注销失败仅记日志（状态与实际注册背离时重启自愈）
        if let Some(previous) = current.take() {
            if let Err(error) = app.global_shortcut().unregister(previous.as_str()) {
                eprintln!("注销快速面板快捷键失败：{error}");
            }
        }
        return Ok(());
    }
    // 先注册新组合成功、再注销旧组合（ADR-0024）：注册失败时旧组合仍然可用，
    // 用户手里始终握着上一个能唤起面板的组合，不会静默丢快捷键
    app.global_shortcut()
        .on_shortcut(shortcut.as_str(), |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                crate::toggle_quick(app);
            }
        })
        .map_err(|error| format!("快捷键注册失败，可能已被其他程序占用，请更换组合键（{error}）"))?;
    if let Some(previous) = current.take() {
        if let Err(error) = app.global_shortcut().unregister(previous.as_str()) {
            eprintln!("注销旧快速面板快捷键失败：{error}");
        }
    }
    *current = Some(shortcut);
    Ok(())
}

#[tauri::command]
pub fn register_quick_shortcut(app: AppHandle, shortcut: String) -> Result<(), String> {
    apply_quick_shortcut(&app, shortcut)
}

/// 快捷键注册失败时的系统通知（zh/en 随界面语言）。Windows 无法查询占用者身份，
/// 只能提示用户更换；开发实例（未打包、无应用身份）上系统通知可能不弹，仅保留日志。
pub fn notify_quick_shortcut_failure(app: &AppHandle, language: &str, shortcut: &str) {
    use tauri_plugin_notification::NotificationExt;
    let body = if language == "en" {
        format!(
            "Failed to register shortcut {shortcut}. It may be taken by another app — pick another one in Settings."
        )
    } else {
        format!("快捷键 {shortcut} 注册失败，可能已被其他程序占用，可在设置中更换。")
    };
    if let Err(error) = app
        .notification()
        .builder()
        .title(app_title(language))
        .body(body)
        .show()
    {
        eprintln!("快捷键注册失败通知发送失败：{error}");
    }
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

/// 探测用的 WorkBuddy 三元组：表单里刚填、尚未保存的三个值（camelCase 与前端一致）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbuddySessionInput {
    session: String,
    session2: String,
    user_agent: String,
}

/// 探测用的小米 MiMo 两值：表单里刚填、尚未保存的 serviceToken 与 userId（camelCase 与前端一致）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MimoCookieInput {
    service_token: String,
    user_id: String,
}

/// 用"刚输入、尚未保存"的凭据值发起一次真实探测请求，验证连通性。
/// auth: "bearer"（携带 credential 作为 Bearer token）| "cookie"（credential 是归一化后的整段 Cookie 头）
/// session_triple：WorkBuddy 的 session / session_2 / 登录 UA 三个值——走与 provider_request
/// 的 session_cookie 通道同一个拼装与校验入口；给出时忽略 auth/credential
/// mimo_pair：MiMo 的 serviceToken / userId 两个值，同走 instances::mimo_cookies
#[tauri::command]
pub async fn diagnose_request(
    url: String,
    auth: Option<String>,
    credential: Option<String>,
    session_triple: Option<WorkbuddySessionInput>,
    mimo_pair: Option<MimoCookieInput>,
    // 随探测附加的静态协议头（如 Qoder 的 Origin/Referer/Bx-V、WorkBuddy 的 x-client-platform），
    // 让探测与刷新链路的请求形态尽量一致
    headers: Option<HashMap<String, String>>,
    // 探测请求的方法：缺省 GET；WorkBuddy 的 billing 族只有 POST，探测要与刷新同法同族
    // （ADR-0031），否则只能去探一个本站未必存在的 GET 端点
    method: Option<String>,
    body_text: Option<String>,
) -> Result<DiagnosisResult, String> {
    // 目的地面先收窄（ADR-0032）：探测的 url 虽由前端常量拼出，但与刷新链路同权，
    // 不受限就等于给渲染进程一条「把刚粘贴的凭据发去任意域」的通道
    instances::validate_probe_url(&url)?;
    let client = http_client();

    let method = match method.as_deref() {
        Some("POST") => Method::POST,
        _ => Method::GET,
    };
    let mut request = client.request(method, &url);
    // 静态协议头先铺（如 Qoder 的 Origin/Referer/Bx-V），但凭据相关头一律剔除：
    // 保证请求里的 Cookie / Authorization / User-Agent 只可能来自下面的鉴权分支
    if let Some(extra) = headers {
        for (name, value) in extra {
            if is_reserved_credential_header(&name) {
                continue;
            }
            request = request.header(name, value);
        }
    }
    if let Some(triple) = session_triple {
        // 复用刷新链路的同一份拼装与字符集校验，探测这里不另写一遍规则：三值合法且
        // 网关放行，才说明保存后能用（ADR-0029 四次修订的三槽录入）
        let session = instances::workbuddy_session(&serde_json::json!({
            "session": triple.session,
            "session2": triple.session2,
            "userAgent": triple.user_agent,
        }))?;
        request = request.header("Cookie", session.cookie_header);
        request = request.header("User-Agent", session.user_agent);
    } else if let Some(pair) = mimo_pair {
        // 与刷新链路的 mimo_cookie 通道同一个拼装与字符集入口：两值合法且网关放行，
        // 才说明保存后能用（测得过即存得过）
        let cookies = instances::mimo_cookies(&serde_json::json!({
            "serviceToken": pair.service_token,
            "userId": pair.user_id,
        }))?;
        request = request.header("Cookie", cookies.cookie_header);
        request = request.header("User-Agent", MIMO_DEFAULT_UA);
    } else {
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
                let header = match opencode_cookie_header(&cookie) {
                    Ok(header) => header,
                    Err(_) => {
                        return Ok(DiagnosisResult::new(
                            false,
                            0,
                            0,
                            "opencode-cookie-format",
                            None,
                        ))
                    }
                };
                request = request.header("Cookie", header);
                request = request.header(
                    "User-Agent",
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0",
                );
            }
            Some("qoder_cookie") => {
                // 凭据是 qoder_session_cookie 的**值**本体（Qoder，ADR-0030 §2 二次修订）：
                // 键名由这里拼进 Cookie 头，UA 用缺省 Chrome 常量，与 provider_request 的
                // qoder_cookie 通道同一拼装口径
                let value = match credential.filter(|value| !value.trim().is_empty()) {
                    Some(value) => value,
                    None => return Ok(DiagnosisResult::new(false, 0, 0, "missing-credential", None)),
                };
                if validate_qoder_session_value(&value).is_err() {
                    return Ok(DiagnosisResult::new(
                        false,
                        0,
                        0,
                        "invalid-credential-format",
                        None,
                    ));
                }
                request = request.header("Cookie", format!("{QODER_SESSION_COOKIE_NAME}={value}"));
                request = request.header("User-Agent", QODER_DEFAULT_UA);
            }
            _ => {}
        }
    }
    if let Some(body) = body_text {
        request = request.body(body);
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

    let (ok, code) = if status == 200 {
        (true, "ok")
    } else if status == 401 || status == 403 {
        (false, "invalid-credentials")
    } else {
        (false, "http-error")
    };

    Ok(DiagnosisResult::new(ok, status, latency_ms, code, None))
}

/// 按界面语言重建托盘右键菜单（zh/en）；菜单事件处理在托盘创建时已注册，重建菜单不影响。
/// 同时记录语言并重放托盘呈现（图标方案 + 动态提示 + macOS 标题），刷新三个窗口的标题。
#[tauri::command]
pub fn refresh_tray_menu(app: AppHandle, language: String) -> Result<(), String> {
    let tray = app
        .tray_by_id("main-tray")
        .ok_or_else(|| "托盘未初始化".to_string())?;
    let menu = crate::build_tray_menu(&app, &language).map_err(|error| error.to_string())?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())?;
    {
        let state = app.state::<crate::tray_scheme::TrayState>();
        *state.language.lock().expect("tray language lock poisoned") = language.clone();
    }
    crate::tray_scheme::apply(&app);
            let title = app_title(&language);
            for label in ["main", "quick", "glance"] {
                if let Some(window) = app.get_webview_window(label) {
                    let _ = window.set_title(&title);
                }
            }
    Ok(())
}

// ─── 通知 ───

/// 告警通知入口（ADR-0025）：带 ruleKey 时后端按墙钟冷却判重，冷却期内返回 null，
/// 前端据此跳过系统通知。冷却时长读设置库；读失败时判重降级为放行——投递韧性优先。
#[tauri::command]
pub fn add_notification(
    state: State<'_, AppState>,
    instance_id: String,
    rule_key: Option<String>,
    title: String,
    body: String,
    params: Option<Value>,
) -> Result<Option<db::StoredNotification>, String> {
    let params_text = match params {
        Some(value) => Some(serde_json::to_string(&value).map_err(|error| error.to_string())?),
        None => None,
    };
    let db = state.db.lock().expect("db lock poisoned");
    let cooldown_ms = match db.get_settings() {
        Ok(settings) => settings
            .get("alertCooldownHours")
            .and_then(|value| value.as_f64())
            .unwrap_or(6.0) as i64
            * 3_600_000,
        Err(error) => {
            eprintln!("读取告警冷却设置失败，本次判重降级为放行：{error}");
            0
        }
    };
    db.add_notification(
        &instance_id,
        rule_key.as_deref(),
        cooldown_ms,
        &title,
        &body,
        params_text.as_deref(),
    )
}

/// 告警规则状态水合（ADR-0025）：评估窗口启动/重载后恢复边沿与冷却
#[tauri::command]
pub fn list_alert_states(state: State<'_, AppState>) -> Result<Vec<db::StoredAlertState>, String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.list_alert_states()
}

/// 告警规则状态回写（ADR-0025）：评估产生的边沿解除等变化持久化到事实源
#[tauri::command]
pub fn save_alert_states(
    state: State<'_, AppState>,
    states: Vec<db::StoredAlertState>,
) -> Result<(), String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.save_alert_states(&states)
}

/// 重置卡已见集合水合：None = 该实例从未播种（首刷播种不通知）
#[tauri::command]
pub fn get_seen_reset_cards(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<Option<db::StoredSeenResetCards>, String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.get_seen_reset_cards(&instance_id)
}

/// 重置卡已见集合回写：重启/F5 后据此恢复「同一张卡只提醒一次」
#[tauri::command]
pub fn save_seen_reset_cards(
    state: State<'_, AppState>,
    seen: db::StoredSeenResetCards,
) -> Result<(), String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.save_seen_reset_cards(&seen)
}

/// WorkBuddy 例程判据读取（ADR-0039）：None = 该实例这一格从未写过（动作没做过、
/// 通知没发过）。kind 说这是什么判据，值按 kind 自解释（CST 日期 / 行程键 / '1' / JSON）
#[tauri::command]
pub fn get_workbuddy_state(
    state: State<'_, AppState>,
    instance_id: String,
    kind: String,
) -> Result<Option<String>, String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.get_workbuddy_state(&instance_id, &kind)
}

/// WorkBuddy 例程判据回写（UPSERT 幂等）：动作与通知的「今天已经做过」都以此为准，
/// 重启、webview 重载、主窗口隐藏后依然成立
#[tauri::command]
pub fn save_workbuddy_state(
    state: State<'_, AppState>,
    record: db::StoredWorkbuddyState,
) -> Result<(), String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.save_workbuddy_state(&record)
}

#[tauri::command]
pub fn list_notifications(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<db::StoredNotification>, String> {
    // limit 收敛到合法区间：SQLite 的 LIMIT -1 语义是「不限制」，不能把负数当全量放行
    let limit = limit.unwrap_or(200).clamp(1, 500);
    let db = state.db.lock().expect("db lock poisoned");
    db.list_notifications(limit)
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

    let client = http_client();

    // 凭据由下面的鉴权分支注入，所以目标域名必须由本进程按实例种类判定，不能跟着
    // 调用方传来的 url 走（ADR-0032）。跨 host 重定向时 reqwest 会剥掉
    // Cookie/Authorization（redirect.rs 的 remove_sensitive_headers），本检查管的是
    // 「第一跳去哪」这件事本身
    instances::validate_request_url(&kind, &url)?;

    let method = match method.as_deref().unwrap_or("GET") {
        "POST" => Method::POST,
        _ => Method::GET,
    };
    let mut request = client.request(method, &url);
    // 调用方传来的凭据相关头先剔除（同名会 append 成两条，靠顺序挡不住），
    // 之后 Cookie / Authorization / User-Agent 只可能由下面的鉴权分支写入
    let mut headers = headers.unwrap_or_default();
    headers.retain(|name, _| !is_reserved_credential_header(name));
    // 任务事件上报分支要在发送前改写事件体（占位符替换），故提前可变持有
    let mut body_text = body_text;

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
                .ok_or_else(|| "缺少 OpenCode Cookie".to_string())?;
            let header = opencode_cookie_header(cookie)?;
            headers.insert("Cookie".to_string(), header);
            headers
                .entry("User-Agent".to_string())
                .or_insert_with(|| {
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0"
                        .to_string()
                });
        }
        Some("session_cookie") if kind == "workbuddy" => {
            // 三个槽位（session / session2 / userAgent）存的都是用户填的原文，拼头与
            // 字符集校验收敛在 instances::workbuddy_session：网关要求 session+session_2
            // 成对、且 UA 与登录时逐字节相同（ADR-0029），缺一即点名报错而不是兜底猜
            let session = instances::workbuddy_session(&instance_credentials)?;
            headers.insert("Cookie".to_string(), session.cookie_header);
            headers.insert("User-Agent".to_string(), session.user_agent);
        }
        Some("workbuddy_token") if kind == "workbuddy" => {
            // token 通道（ADR-0034）：Bearer + 官方桌面端 billing UA + X-User-Id（企业号
            // 再加 X-Enterprise-Id/X-Tenant-Id，参考 BillingHeaders 同款「非空才带」）
            // 这些凭据衍生头只由这里注入——uid 在 vault 里，前端只见槽位布尔拿不到明文。
            // 其余静态协议头（X-CodeBuddy-Request / X-Domain / Origin 等）由前端按
            // 站点档案随请求传入，与 Cookie 通道的 x-client-platform 同先例
            let token = instances::workbuddy_token(&instance_credentials)?;
            headers.insert(
                "Authorization".to_string(),
                format!("Bearer {}", token.access_token),
            );
            headers.insert("User-Agent".to_string(), WORKBUDDY_BILLING_UA.to_string());
            headers.insert("X-User-Id".to_string(), token.uid);
            if !token.enterprise_id.is_empty() {
                headers.insert("X-Enterprise-Id".to_string(), token.enterprise_id.clone());
                headers.insert("X-Tenant-Id".to_string(), token.enterprise_id);
            }
        }
        Some("workbuddy_report") if kind == "workbuddy" => {
            // 任务事件上报（ADR-0036）：头注入同 token 通道，UA 按上报域取形态——
            // copilot 域（桌面指纹事件）用桌面三段 UA，其余（chat 活跃/mp 事件的
            // codebuddy.cn）用 billing 单段 UA；事件体里的凭据占位符（{{WB_UID}} 等，
            // 含 uid 派生的设备标识与昵称）在此替换，前端全程不见明文
            let token = instances::workbuddy_token(&instance_credentials)?;
            headers.insert(
                "Authorization".to_string(),
                format!("Bearer {}", token.access_token),
            );
            // 桌面 UA 按 host 精确比较（非字符串前缀——starts_with 是路径语义，白名单
            // 或调用点将来变动时易漂移）；validate_request_url 已保证 host 在白名单内
            let desktop_report = reqwest::Url::parse(&url)
                .ok()
                .and_then(|parsed| parsed.host_str().map(|host| host == "copilot.tencent.com"))
                .unwrap_or(false);
            headers.insert(
                "User-Agent".to_string(),
                if desktop_report {
                    WORKBUDDY_DESKTOP_UA.to_string()
                } else {
                    WORKBUDDY_BILLING_UA.to_string()
                },
            );
            headers.insert("X-User-Id".to_string(), token.uid.clone());
            if !token.enterprise_id.is_empty() {
                headers.insert("X-Enterprise-Id".to_string(), token.enterprise_id.clone());
                headers.insert("X-Tenant-Id".to_string(), token.enterprise_id);
            }
            if let Some(body) = body_text.as_mut() {
                *body = workbuddy_fill_report_placeholders(body, &token.uid, &token.nickname);
            }
        }
        Some("session_cookie") => return Err("不支持的 provider session_cookie auth".to_string()),
        Some("workbuddy_token") => {
            return Err("不支持的 provider workbuddy_token auth".to_string())
        }
        Some("workbuddy_report") => {
            return Err("不支持的 provider workbuddy_report auth".to_string())
        }
        Some("qoder_cookie") => {
            // vault 槽位存用户粘贴的 qoder_session_cookie 的**值**本体（Qoder 网页登录态，
            // ADR-0030 §2 二次修订）：键名由这里拼进 Cookie 头，输入本身不加工。UA 缺省用
            // Chrome 常量（Qoder 网关不校验 UA 与登录会话同源——CodexBar 硬编码 UA 实证，
            // 与 WorkBuddy 的 session_cookie 通道逐字节 UA 校验是两种网关）。Origin/Referer/
            // Bx-V 等静态协议头与 WorkBuddy 的 x-client-platform 同先例，由前端随端点定义传入
            let slot = credential_slot
                .clone()
                .ok_or_else(|| "qoder_cookie auth 需要 credential_slot".to_string())?;
            let value = resolve_bearer_key(&kind, &slot, &instance_credentials)?;
            validate_qoder_session_value(value).map_err(|_| {
                "凭据不是合法的 Cookie 值，请只粘贴 qoder_session_cookie 的值（不带键名、分号或空格）"
                    .to_string()
            })?;
            headers.insert(
                "Cookie".to_string(),
                format!("{QODER_SESSION_COOKIE_NAME}={value}"),
            );
            headers
                .entry("User-Agent".to_string())
                .or_insert_with(|| QODER_DEFAULT_UA.to_string());
        }
        Some("mimo_cookie") if kind == "mimo" => {
            // 两格（serviceToken / userId）存的都是用户填的值原文，拼头与字符集校验收敛在
            // instances::mimo_cookies（与 workbuddy 的 session_cookie 同法）：上游把两个键
            // 都列为必需，缺一即点名报错而不是兜底猜一个（ADR-0038）
            let cookies = instances::mimo_cookies(&instance_credentials)?;
            headers.insert("Cookie".to_string(), cookies.cookie_header);
            headers
                .entry("User-Agent".to_string())
                .or_insert_with(|| MIMO_DEFAULT_UA.to_string());
        }
        Some("mimo_cookie") => return Err("不支持的 provider mimo_cookie auth".to_string()),
        Some("qoder_device") if kind == "qoder" => {
            // 扫码 token 通道（ADR-0041）：Bearer 设备 token 打 openapi 上的 /sash 族。
            // 逆向实现附带的 Cosy-ClientType 与 UA "Qoder" 对用量端点是无效变量
            // （真机 A/B：10 / 5 / 不发 三份 body 逐字相同），所以这里只发 Bearer
            let token = instances::qoder_access_token(&instance_credentials)?;
            headers.insert("Authorization".to_string(), format!("Bearer {token}"));
        }
        Some("qoder_device") => {
            return Err("不支持的 provider qoder_device auth".to_string())
        }
        Some("mimo_pass") if kind == "mimo" => {
            // 扫码通道（ADR-0042）：vault 里存的是 30 天的 passToken，而 serviceToken 是
            // 会话级 Cookie（上游 Set-Cookie 不给 Max-Age），所以每轮刷新在这里现铸一张
            // 再拼头——铸票三步都在 mimo_mint_service_token，前端全程不接触小米凭据
            let pass = instances::mimo_pass(&instance_credentials)?;
            let service_token = mimo_mint_service_token(&pass).await?;
            headers.insert(
                "Cookie".to_string(),
                format!(
                    "{}={service_token}; {}={}",
                    instances::MIMO_SERVICE_TOKEN_COOKIE,
                    instances::MIMO_USER_ID_COOKIE,
                    pass.user_id
                ),
            );
            headers
                .entry("User-Agent".to_string())
                .or_insert_with(|| MIMO_DEFAULT_UA.to_string());
        }
        Some("mimo_pass") => return Err("不支持的 provider mimo_pass auth".to_string()),
        Some("cookie") => return Err("不支持的 provider cookie auth".to_string()),
        _ => {}
    }

    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(body) = body_text {
        request = request.body(body);
    }

    let response = request.send().await.map_err(|error| network_error_text(&error))?;
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
    let body_text = response.text().await.map_err(|error| network_error_text(&error))?;

    Ok(ProviderResponse {
        status,
        headers: response_headers,
        body_text,
    })
}

// ─── WorkBuddy 扫码登录与 token 通道（ADR-0034）───

/// 授权三端点的官方 CLI 指纹（参考实现 cmd/login 同款，2026-09-26 spike 真机验证）
pub const WORKBUDDY_AUTH_UA: &str = "CLI/2.63.2 CodeBuddy/2.63.2";
/// billing 族（签到/余额）的官方桌面端单段 UA（参考实现 headers.go billingUA 同款）
pub const WORKBUDDY_BILLING_UA: &str = "WorkBuddy/5.5.4";
/// 任务事件上报的桌面端三段 UA（参考实现 desktop.go desktopUA 同款；copilot 域
/// 桌面指纹事件用它，计分判据在事件体的指纹字段，UA 是网关层辅助形态）
pub const WORKBUDDY_DESKTOP_UA: &str = "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1";

/// 由 uid 稳定派生 36 位 hex 设备标识（machineId/sessionId/web machineId 复用同一
/// 实现，参考实现 desktop.go deriveID 同款：sha256(salt + ":" + uid) 前 18 字节，
/// 同一账号恒定同一标识，模拟固定设备）
fn workbuddy_task_device_id(uid: &str, salt: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("{salt}:{uid}").as_bytes());
    digest[..18].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 任务事件体的凭据占位符替换（ADR-0036）：uid 与其派生设备标识、扫码昵称都只在
/// vault/后端存在，前端构造事件体时以占位符书写，发送前在此替换。占位符出现在
/// JSON 字符串值的位置，替换值需过 JSON 转义（昵称可含任意 Unicode）。包裹引号
/// 用 strip_prefix/suffix 各剥**一层**——trim_matches 会把结尾转义序列 `\"` 的引号
/// 一起剥掉，剩余裸反斜杠会把事件体 JSON 扭弯（安全审查 2026-09-26）
fn workbuddy_fill_report_placeholders(body: &str, uid: &str, nickname: &str) -> String {
    let escaped_nickname = serde_json::to_string(nickname)
        .unwrap_or_default()
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or_default()
        .to_string();
    body.replace("{{WB_UID}}", uid)
        .replace("{{WB_NICKNAME}}", &escaped_nickname)
        .replace(
            "{{WB_MACHINE_ID}}",
            &workbuddy_task_device_id(uid, "machine"),
        )
        .replace(
            "{{WB_SESSION_ID}}",
            &workbuddy_task_device_id(uid, "session"),
        )
        .replace(
            "{{WB_WEB_MACHINE_ID}}",
            &workbuddy_task_device_id(uid, "webmachine"),
        )
}

/// 站点取值（与实例 site 同一取值域）→ 授权端点 base：中国站在腾讯 copilot 域，
/// 国际站在 workbuddy.ai（参考实现 upstreamBaseCN/Global，登录端点两站均有证据）
fn workbuddy_auth_base(site: &str) -> &'static str {
    if site == "international" {
        "https://www.workbuddy.ai"
    } else {
        "https://copilot.tencent.com"
    }
}

/// 账号域 Origin/Referer（授权与 billing 头族用它，与请求所在的网关域不必相同——
/// 中国站请求打 copilot.tencent.com 而 Origin 报 www.codebuddy.cn，spike 实证放行）
fn workbuddy_account_origin(site: &str) -> &'static str {
    if site == "international" {
        "https://www.workbuddy.ai"
    } else {
        "https://www.codebuddy.cn"
    }
}

/// Accept-Language 按站取（参考实现 D5：官方客户端按账号域发对应语言标识）
fn workbuddy_accept_language(site: &str) -> &'static str {
    if site == "international" {
        "en-US"
    } else {
        "zh-CN"
    }
}

/// 刷新端点的三段式 UA（参考实现 userAgent(a)：官方桌面端 RestOperations 形态）。
/// global 的第二段平台名是 `WorkBuddy AI`——送 CN 形态可能触发上游 403 code 11140
/// 风控（headers.go 逆向注释），版本段以参考实现内置默认为准
fn workbuddy_refresh_ua(site: &str) -> String {
    let platform = if site == "international" {
        "WorkBuddy AI"
    } else {
        "WorkBuddy"
    };
    format!("WorkBuddy/5.5.4 {platform}/5.5.4 CLI/2.137.1")
}

/// 账号级稳定设备指纹（参考实现 deriveAccountStableID 同式）：sha256("wb2a:"+purpose+":"+uid)
/// 截前 36 hex。跨重启稳定、账号间互异，只用于刷新头族的 X-Machine-ID / X-Session-ID
fn workbuddy_account_stable_id(uid: &str, purpose: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("wb2a:{purpose}:{uid}").as_bytes());
    digest[..18].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 业务信封统一处理：返回 (业务是否成功, data)。授权族信封 pending 时 HTTP 200 但
/// code≠0（spike 实测 msg "login ing"），所以成败只看业务码不看状态码
fn workbuddy_envelope(body: &str) -> Result<(bool, String, Value), String> {
    let json: Value =
        serde_json::from_str(body).map_err(|error| format!("响应不是 JSON：{error}"))?;
    let msg = json["msg"].as_str().unwrap_or_default().to_string();
    let code = &json["code"];
    let ok = code.is_null()
        || matches!(code.as_i64(), Some(0) | Some(200))
        || matches!(code.as_str(), Some("0") | Some("200"));
    let data = json.get("data").cloned().unwrap_or(Value::Null);
    Ok((ok, msg, data))
}

/// 校验实例是 workbuddy 并返回其站点；扫码三命令的公共前置
fn workbuddy_instance_site(state: &State<'_, AppState>, instance_id: &str) -> Result<String, String> {
    let db = state.db.lock().expect("db lock poisoned");
    let instance = db
        .get_instance(instance_id)?
        .ok_or_else(|| "供应商实例不存在，请刷新后重试".to_string())?;
    if instance.provider_id != "workbuddy" {
        return Err("扫码登录仅支持 WorkBuddy 实例".to_string());
    }
    Ok(instance.site)
}

/// 进行中的扫码会话（进程内存态）：上游 state 15 分钟有效，过期即作废重扫。
/// 以 state 本身为键（ADR-0035 无实例会话）——发起扫码不需要实例先存在，
/// poll 确认后凭据暂存于此、等 qr_claim 写入实例 vault，全程不过前端
#[derive(Clone)]
pub struct WorkbuddyLoginSession {
    pub site: String,
    pub created_at: i64,
    /// poll 确认后暂存的凭据（token 族槽位 json）；None = 尚未确认
    pub credentials: Option<Value>,
}

const WORKBUDDY_LOGIN_TTL_MS: i64 = 15 * 60 * 1000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbuddyQrStartResponse {
    /// 授权链接（authUrl）：整段编码为二维码或复制到浏览器打开。spike 实证该链接
    /// 必须一字不差——尾部参数被截断时上游报「登录链接不完整」
    pub auth_url: String,
    /// 会话键（即上游 state）：后续 poll 与 claim 都用它；已在二维码里曝光，非新增敏感面
    pub session_key: String,
}

/// 发起扫码登录：向授权端点签发 state，返回浏览器授权链接与会话键。链接由本函数按
/// 站点常量拼出 URL（不经调用方输入，天然落在白名单域），前端只负责把它变成二维码
#[tauri::command]
pub async fn workbuddy_qr_start(
    state: State<'_, AppState>,
    site: String,
) -> Result<WorkbuddyQrStartResponse, String> {
    let origin = workbuddy_account_origin(&site);
    let url = format!("{}/v2/plugin/auth/state?platform=CLI", workbuddy_auth_base(&site));
    let response = http_client()
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/plain, */*")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Origin", origin)
        .header("Referer", format!("{origin}/"))
        .header("User-Agent", WORKBUDDY_AUTH_UA)
        .body("{}")
        .send()
        .await
        .map_err(|error| network_error_text(&error))?;
    let body = response
        .text()
        .await
        .map_err(|error| network_error_text(&error))?;
    let (ok, msg, data) = workbuddy_envelope(&body)?;
    if !ok {
        return Err(format!("发起扫码登录失败：{}", if msg.is_empty() { "服务端未说明原因" } else { &msg }));
    }
    let login_state = data["state"]
        .as_str()
        .ok_or_else(|| "发起扫码登录失败：响应缺少 state".to_string())?
        .to_string();
    let auth_url = data["authUrl"]
        .as_str()
        .ok_or_else(|| "发起扫码登录失败：响应缺少授权链接".to_string())?
        .to_string();
    state
        .workbuddy_logins
        .lock()
        .expect("workbuddy login lock poisoned")
        .insert(
            login_state.clone(),
            WorkbuddyLoginSession {
                site,
                created_at: db::chrono_utc_now(),
                credentials: None,
            },
        );
    Ok(WorkbuddyQrStartResponse {
        auth_url,
        session_key: login_state,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbuddyQrPollResponse {
    /// pending=等待手机侧完成登录；confirmed=换到 token 并已写入凭据库；
    /// expired=会话不存在或超 15 分钟，需重新发起
    pub status: String,
    pub nickname: Option<String>,
    pub expires_at_ms: Option<i64>,
}

/// 查询扫码登录进度（前端每 3 秒轮询）：确认完成后换 token、取账号摘要并把凭据
/// **暂存进会话**（ADR-0035）——不写库，qr_claim 时才落实例 vault；编辑态由前端在
/// confirmed 后自动 claim（保留「写库即生效」），新增态等保存流程 claim
#[tauri::command]
pub async fn workbuddy_qr_poll(
    state: State<'_, AppState>,
    session_key: String,
) -> Result<WorkbuddyQrPollResponse, String> {
    let now = db::chrono_utc_now();
    let session = {
        let mut logins = state
            .workbuddy_logins
            .lock()
            .expect("workbuddy login lock poisoned");
        match logins.get(&session_key) {
            Some(session) if now - session.created_at <= WORKBUDDY_LOGIN_TTL_MS => {
                Some(session.clone())
            }
            Some(_) => {
                logins.remove(&session_key);
                None
            }
            None => None,
        }
    };
    let Some(session) = session else {
        return Ok(WorkbuddyQrPollResponse {
            status: "expired".to_string(),
            nickname: None,
            expires_at_ms: None,
        });
    };
    // 已确认过的会话：上游 state 换 token 是一次性的，重复轮询直接回放确认结果，
    // 不再打上游（前端 confirmed 后停表，这条是防御路径）
    if let Some(credentials) = &session.credentials {
        let nickname = instances::instance_credential(credentials, "nickname")
            .map(|value| value.to_string());
        let expires_at_ms = instances::instance_credential(credentials, "expiresAt")
            .and_then(|raw| raw.parse::<i64>().ok());
        return Ok(WorkbuddyQrPollResponse {
            status: "confirmed".to_string(),
            nickname,
            expires_at_ms,
        });
    }
    let origin = workbuddy_account_origin(&session.site);
    let token_url = format!(
        "{}/v2/plugin/auth/token?state={}",
        workbuddy_auth_base(&session.site),
        session_key
    );
    let response = http_client()
        .get(&token_url)
        .header("Accept", "application/json, text/plain, */*")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Origin", origin)
        .header("Referer", format!("{origin}/"))
        .header("User-Agent", WORKBUDDY_AUTH_UA)
        .send()
        .await
        .map_err(|error| network_error_text(&error))?;
    let body = response
        .text()
        .await
        .map_err(|error| network_error_text(&error))?;
    let (ok, _msg, data) = workbuddy_envelope(&body)?;
    if !ok {
        return Ok(WorkbuddyQrPollResponse {
            status: "pending".to_string(),
            nickname: None,
            expires_at_ms: None,
        });
    }
    let access_token = data["accessToken"].as_str().ok_or_else(|| {
        "扫码登录完成但响应缺少 accessToken，请重新扫码".to_string()
    })?;
    let refresh_token = data["refreshToken"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    // expiresIn 缺失按 0 处理：expiresAt 记为当前时刻，续期链下一轮会先行刷新
    let expires_in_ms = data["expiresIn"].as_i64().unwrap_or(0) * 1000;

    let account_url = format!(
        "{}/v2/plugin/login/account?state={}",
        workbuddy_auth_base(&session.site),
        session_key
    );
    let account_response = http_client()
        .get(&account_url)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Accept", "application/json, text/plain, */*")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Origin", origin)
        .header("Referer", format!("{origin}/"))
        .header("User-Agent", WORKBUDDY_AUTH_UA)
        .send()
        .await
        .map_err(|error| network_error_text(&error))?;
    let account_body = account_response
        .text()
        .await
        .map_err(|error| network_error_text(&error))?;
    let (_account_ok, _account_msg, account) = workbuddy_envelope(&account_body)?;
    let uid = account["uid"].as_str().unwrap_or_default().trim().to_string();
    if uid.is_empty()
        || uid.len() > 64
        || !uid
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("扫码账号信息异常（uid 非法），请重新扫码".to_string());
    }
    let nickname = account["nickname"].as_str().unwrap_or_default().to_string();
    let enterprise_id = account["enterpriseId"].as_str().unwrap_or_default().to_string();

    let mut credentials = serde_json::json!({
        "accessToken": access_token,
        "expiresAt": (now + expires_in_ms).to_string(),
        "uid": uid,
    });
    // refreshToken / nickname / enterpriseId 可能为空：save_instance_credentials 跳过空串，
    // 槽位不写——展示与续期各自对缺槽容错（摘要显示 uid、续期报错重扫）
    let slots = [
        ("refreshToken", refresh_token),
        ("nickname", nickname.clone()),
        ("enterpriseId", enterprise_id),
    ];
    if let Some(object) = credentials.as_object_mut() {
        for (slot, value) in slots {
            if !value.is_empty() {
                object.insert(slot.to_string(), Value::String(value));
            }
        }
    }
    // 暂存回会话并重置 TTL：claim 窗口自确认时刻重新计 15 分钟（用户扫码后
    // 填备注/阈值再点保存，不该被发起时刻的窗口挤掉）
    state
        .workbuddy_logins
        .lock()
        .expect("workbuddy login lock poisoned")
        .insert(
            session_key.clone(),
            WorkbuddyLoginSession {
                site: session.site.clone(),
                created_at: db::chrono_utc_now(),
                credentials: Some(credentials),
            },
        );
    Ok(WorkbuddyQrPollResponse {
        status: "confirmed".to_string(),
        nickname: if nickname.is_empty() { None } else { Some(nickname) },
        expires_at_ms: Some(now + expires_in_ms),
    })
}

/// 认领扫码产物（ADR-0035）：把会话暂存的凭据写入指定实例的 vault，并清空三格
/// Cookie 槽保互斥（登录方式选「扫码登录」即只留 token 族）。新增态由保存流程
/// 调用（先建实例后认领），编辑态由前端在扫码确认后自动调用（写库即生效）
#[tauri::command]
pub async fn workbuddy_qr_claim(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    session_key: String,
) -> Result<(), String> {
    workbuddy_instance_site(&state, &instance_id)?;
    let mut credentials = {
        let logins = state
            .workbuddy_logins
            .lock()
            .expect("workbuddy login lock poisoned");
        match logins.get(&session_key) {
            Some(session) if session.credentials.is_some() => session
                .credentials
                .clone()
                .expect("presence checked above"),
            Some(_) => {
                return Err("扫码会话尚未确认，请等待手机完成登录".to_string());
            }
            None => {
                return Err("扫码会话不存在或已过期，请重新发起扫码".to_string());
            }
        }
    };
    // 互斥（ADR-0035）：token 族写入的同时清三格 Cookie 槽
    if let Some(object) = credentials.as_object_mut() {
        for slot in ["session", "session2", "userAgent"] {
            object.insert(slot.to_string(), Value::Null);
        }
    }
    save_instance_credentials(state.clone(), &instance_id, &credentials)?;
    state
        .workbuddy_logins
        .lock()
        .expect("workbuddy login lock poisoned")
        .remove(&session_key);
    let _ = app.emit("credentials-changed", ());
    Ok(())
}

/// 手动/自动续期（ADR-0034：每日一刷与 401 即时救共用）：双 token 一起轮换写回 vault。
/// 失败返回 Err 携带原因——旧 token 原样保留，下轮再试（参考实现同款取舍）
#[tauri::command]
pub async fn workbuddy_token_refresh(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<bool, String> {
    let site = workbuddy_instance_site(&state, &instance_id)?;
    let instance_credentials = {
        let vault = state.vault.lock().expect("vault lock poisoned");
        vault
            .credentials()?
            .get(&instance_id)
            .cloned()
            .unwrap_or(Value::Null)
    };
    let refresh_token = instances::instance_credential(&instance_credentials, "refreshToken")
        .ok_or_else(|| {
            format!(
                "缺少 {}，请重新扫码登录",
                instances::credential_label("workbuddy", "refreshToken").unwrap_or("refreshToken")
            )
        })?
        .to_string();
    let uid = instances::instance_credential(&instance_credentials, "uid")
        .map(|value| value.to_string())
        .unwrap_or_default();
    let enterprise_id = instances::instance_credential(&instance_credentials, "enterpriseId")
        .map(|value| value.to_string())
        .unwrap_or_default();

    let origin = workbuddy_account_origin(&site);
    let url = format!("{}/v2/plugin/auth/token/refresh", workbuddy_auth_base(&site));
    let mut request = http_client()
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Origin", origin)
        .header("Referer", format!("{origin}/"))
        .header("User-Agent", workbuddy_refresh_ua(&site))
        .header("X-CodeBuddy-Request", "1")
        .header("Accept-Language", workbuddy_accept_language(&site))
        .header("X-Refresh-Token", refresh_token)
        .header("X-Auth-Refresh-Source", "plugin")
        .body("{}");
    // 头族按参考实现 RefreshHeaders 全量（调研 risks 点名实现前读原文，2026-09-26 已核）
    if !uid.is_empty() {
        request = request
            .header("X-Machine-ID", workbuddy_account_stable_id(&uid, "machine"))
            .header("X-Session-ID", workbuddy_account_stable_id(&uid, "session"))
            .header("X-User-Id", uid.clone());
    }
    if !enterprise_id.is_empty() {
        request = request.header("X-Enterprise-Id", enterprise_id);
    }
    let response = request
        .send()
        .await
        .map_err(|error| network_error_text(&error))?;
    let body = response
        .text()
        .await
        .map_err(|error| network_error_text(&error))?;
    let (ok, msg, data) = workbuddy_envelope(&body)?;
    if !ok {
        return Err(format!(
            "token 续期失败：{}",
            if msg.is_empty() { "服务端未说明原因" } else { &msg }
        ));
    }
    let access_token = data["accessToken"]
        .as_str()
        .ok_or_else(|| "token 续期响应缺少 accessToken，旧 token 已保留".to_string())?
        .to_string();
    let new_refresh_token = data["refreshToken"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let expires_in_ms = data["expiresIn"].as_i64().unwrap_or(0) * 1000;
    let mut credentials = serde_json::json!({
        "accessToken": access_token,
        "expiresAt": (db::chrono_utc_now() + expires_in_ms).to_string(),
    });
    if !new_refresh_token.is_empty() {
        if let Some(object) = credentials.as_object_mut() {
            object.insert(
                "refreshToken".to_string(),
                Value::String(new_refresh_token),
            );
        }
    }
    save_instance_credentials(state, &instance_id, &credentials)?;
    Ok(true)
}

// ─── 扫码登录：Qoder 设备码与小米 MiMo 长轮询（ADR-0041 / ADR-0042）───

/// 进行中的扫码会话（进程内存态，与 WorkBuddy 的 workbuddy_logins 同法但三家共用一张表）。
/// 键是我们自己生成的 uuid——上游的 state/nonce/ticket 只存在会话里，不外泄成前端可见的
/// 会话键（ADR-0035 当年用 state 当键，理由是「已在二维码里曝光」；uuid 更省事也更干净）
#[derive(Clone)]
pub struct QrLoginSession {
    pub kind: String,
    pub site: String,
    pub created_at: i64,
    /// 本会话的等待窗口：Qoder 沿用 WorkBuddy 的 15 分钟，MiMo 用上游给的 timeout
    pub ttl_ms: i64,
    /// 等待凭据：Qoder 是本地生成的 code_verifier，MiMo 是我们自造的 deviceId
    pub secret: String,
    /// 轮询地址：Qoder 由本地参数拼好，MiMo 是上游回的 lp
    pub poll_url: String,
    /// 确认后暂存的凭据（槽位 json）；None = 尚未确认
    pub credentials: Option<Value>,
}

const QR_LOGIN_DEFAULT_TTL_MS: i64 = 15 * 60 * 1000;

fn qr_session(state: &State<'_, AppState>, session_key: &str) -> Result<Option<QrLoginSession>, String> {
    let now = db::chrono_utc_now();
    let mut logins = state.qr_logins.lock().expect("qr login lock poisoned");
    match logins.get(session_key) {
        Some(session) if now - session.created_at <= session.ttl_ms => Ok(Some(session.clone())),
        Some(_) => {
            logins.remove(session_key);
            Ok(None)
        }
        None => Ok(None),
    }
}

fn qr_session_store(state: &State<'_, AppState>, session_key: &str, session: QrLoginSession) {
    state
        .qr_logins
        .lock()
        .expect("qr login lock poisoned")
        .insert(session_key.to_string(), session);
}

/// 小米 MiMo 的扫码产物只有 passToken 能落盘（30 天），serviceToken 每轮现铸
fn qr_staged_credentials(state: &State<'_, AppState>, session_key: &str) -> Result<Value, String> {
    let session = qr_session(state, session_key)?
        .ok_or_else(|| "扫码会话不存在或已过期，请重新发起扫码".to_string())?;
    session
        .credentials
        .clone()
        .ok_or_else(|| "扫码会话尚未确认，请等待手机完成登录".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrStartResponse {
    /// 授权链接：整段编码为二维码或复制到浏览器打开，截断即失效
    pub auth_url: String,
    /// 会话键（我们自造的 uuid）：后续 poll 与 claim 都用它
    pub session_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrPollResponse {
    /// pending=等待另一侧完成登录；confirmed=已换到凭据并暂存；expired=会话过期需重扫
    pub status: String,
    pub nickname: Option<String>,
    pub expires_at_ms: Option<i64>,
}

/// Qoder 设备码的两站常量。CN 的 client_id/redirect_uri 是 2026-10-09 真机扫码实证的
/// （QoderWork CN 桌面端那一个）；国际站那一对出自 yetone/magpie（注释标 verified against
/// live captures），端点存在性另经零凭据探测确认，2026-10-10 也已应用内扫码实证。
/// 同站可以有多个合法 client_id：`e883ade2-…` 是 Qoder CLI 两家共用的那一个
struct QoderDeviceSite {
    website: &'static str,
    openapi: &'static str,
    client_id: &'static str,
    redirect_uri: &'static str,
}

const QODER_DEVICE_CHINA: QoderDeviceSite = QoderDeviceSite {
    website: "qoder.com.cn",
    openapi: "openapi.qoder.com.cn",
    // QoderWork CN prod 的 OAuth client_id（逆向实现同款，真机扫码实证可用）
    client_id: "1c5e33e1-364d-4ce6-b02c-acaa81274a5c",
    redirect_uri: "qoder-work-cn://",
};

const QODER_DEVICE_INTERNATIONAL: QoderDeviceSite = QoderDeviceSite {
    website: "qoder.com",
    openapi: "openapi.qoder.sh",
    client_id: "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa",
    redirect_uri: "qoder-app://",
};

fn qoder_device_site(site: &str) -> &'static QoderDeviceSite {
    if site == "international" {
        &QODER_DEVICE_INTERNATIONAL
    } else {
        &QODER_DEVICE_CHINA
    }
}

/// 发起 Qoder 扫码：**不打任何上游请求**——设备码流程的 PKCE 对、nonce、machine_id 全部
/// 本地生成，授权链接拼出来就能开始轮询。所以「用户还没打开授权页」时 poll 只会拿到
/// 404 NotFound（服务端还不认识这个 nonce），那是等待态而不是错误
#[tauri::command]
pub async fn qoder_qr_start(state: State<'_, AppState>, site: String) -> Result<QrStartResponse, String> {
    let device = qoder_device_site(&site);
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use sha2::{Digest, Sha256};

    let mut raw_verifier = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut raw_verifier);
    let verifier = URL_SAFE_NO_PAD.encode(raw_verifier);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let nonce = uuid::Uuid::new_v4().to_string();
    // 每次扫码新生成（逆向实现同款设备隔离：池内多账号不该被上游看成同一台设备）
    let machine_id = uuid::Uuid::new_v4().to_string();

    let auth_url = format!(
        "https://{}/device/selectAccounts?challenge={}&challenge_method=S256&nonce={}&machine_id={}&client_id={}&redirect_uri={}",
        device.website,
        urlencoding(&challenge),
        urlencoding(&nonce),
        urlencoding(&machine_id),
        urlencoding(device.client_id),
        urlencoding(device.redirect_uri),
    );
    let poll_url = format!(
        "https://{}/api/v1/deviceToken/poll?nonce={}&verifier={}&challenge_method=S256",
        device.openapi,
        urlencoding(&nonce),
        urlencoding(&verifier),
    );
    let session_key = uuid::Uuid::new_v4().to_string();
    qr_session_store(
        &state,
        &session_key,
        QrLoginSession {
            kind: "qoder".to_string(),
            site,
            created_at: db::chrono_utc_now(),
            ttl_ms: QR_LOGIN_DEFAULT_TTL_MS,
            secret: verifier,
            poll_url,
            credentials: None,
        },
    );
    Ok(QrStartResponse { auth_url, session_key })
}

/// 极简百分号编码：授权链接与轮询地址里的参数值都是我们自己生成的（uuid / base64url，
/// 只可能带 `+` `/` `=` `-` `_`），`+` 在 query 里会被解成空格，故必须编。
/// 不用 urlencoding crate：为三五个字符引一个新依赖不值当
fn urlencoding(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 轮询 Qoder 设备码：200 且带 token = 确认；401/403 = 硬错误（client_id/参数被拒）；
/// **其余（404/425/429/5xx）一律 pending**——未授权时上游就是回 404 NotFound
#[tauri::command]
pub async fn qoder_qr_poll(
    state: State<'_, AppState>,
    session_key: String,
) -> Result<QrPollResponse, String> {
    let Some(session) = qr_session(&state, &session_key)? else {
        return Ok(QrPollResponse { status: "expired".to_string(), nickname: None, expires_at_ms: None });
    };
    if let Some(credentials) = &session.credentials {
        // 已确认过：device token 是一次性换发的，重复轮询只回放结果，不再打上游。
        // 有效期不在这里回——它按上游的 ISO 串原样存在 expiresAt 槽，摘要行由前端格式化
        let nickname = instances::instance_credential(credentials, "nickname").map(String::from);
        return Ok(QrPollResponse { status: "confirmed".to_string(), nickname, expires_at_ms: None });
    }
    let device = qoder_device_site(&session.site);
    let response = http_client()
        .get(&session.poll_url)
        .header("Accept", "application/json, text/plain, */*")
        .send()
        .await
        .map_err(|error| network_error_text(&error))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| network_error_text(&error))?;
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(format!(
            "Qoder 设备码被上游拒绝（HTTP {}）：{}",
            status.as_u16(),
            truncate_error_body(&body)
        ));
    }
    if !status.is_success() {
        return Ok(QrPollResponse { status: "pending".to_string(), nickname: None, expires_at_ms: None });
    }
    let json: Value = serde_json::from_str(&body)
        .map_err(|error| format!("Qoder 设备码响应不是 JSON：{error}"))?;
    let access_token = json["token"].as_str().or_else(|| json["device_token"].as_str()).unwrap_or("");
    if access_token.is_empty() {
        // 2xx 但没 token：与逆向实现一致，按「还没完成」继续等
        return Ok(QrPollResponse { status: "pending".to_string(), nickname: None, expires_at_ms: None });
    }
    let refresh_token = json["refresh_token"].as_str().unwrap_or_default().to_string();
    // 有效期只信绝对时刻 expires_at（ISO 串）：同响应里的 expires_in 实测是 2591999998
    // （按秒算是 82 年），是坏值——逆向实现那句「优先用 expires_in」不能照抄
    let expires_at_raw = json["expires_at"].as_str().unwrap_or_default().to_string();
    let uid = json["user_id"].as_str().unwrap_or_default().trim().to_string();
    if uid.is_empty()
        || uid.len() > 64
        || !uid.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("扫码账号信息异常（uid 非法），请重新扫码".to_string());
    }
    // 昵称只为摘要那一行；拿不到不阻断登录（uid 足够点名账号）
    let nickname = match http_client()
        .get(format!("https://{}/api/v1/userinfo", device.openapi))
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {access_token}"))
        .send()
        .await
    {
        Ok(response) => match response.text().await {
            Ok(body) => serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|info| info["name"].as_str().map(String::from))
                .unwrap_or_default(),
            Err(_) => String::new(),
        },
        Err(_) => String::new(),
    };

    let mut credentials = serde_json::json!({
        "accessToken": access_token,
        "uid": uid,
    });
    if let Some(object) = credentials.as_object_mut() {
        for (slot, value) in [
            ("refreshToken", refresh_token),
            ("nickname", nickname.clone()),
            ("expiresAt", expires_at_raw),
        ] {
            if !value.is_empty() {
                object.insert(slot.to_string(), Value::String(value));
            }
        }
    }
    qr_session_store(
        &state,
        &session_key,
        // 确认即重置 TTL：claim 窗口自确认时刻重新计（用户扫完还要填备注/阈值再点保存，
        // 不该被发起时刻的窗口挤掉——与 WorkBuddy 的 qr_poll 同一处理）
        QrLoginSession { credentials: Some(credentials), created_at: db::chrono_utc_now(), ..session },
    );
    Ok(QrPollResponse {
        status: "confirmed".to_string(),
        nickname: if nickname.is_empty() { None } else { Some(nickname) },
        expires_at_ms: None,
    })
}

/// 上游错误体可能很长（HTML 页），点名用截断
fn truncate_error_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.chars().count() > 200 {
        format!("{}…", trimmed.chars().take(200).collect::<String>())
    } else {
        trimmed.to_string()
    }
}

/// 认领 Qoder 扫码产物：写 token 族并清空 Cookie 槽（登录方式互斥，ADR-0035 同款）
#[tauri::command]
pub async fn qoder_qr_claim(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    session_key: String,
) -> Result<(), String> {
    let instance = qr_instance_of(&state, &instance_id, "qoder")?;
    let mut credentials = qr_staged_credentials(&state, &session_key)?;
    if let Some(object) = credentials.as_object_mut() {
        object.insert("cookie".to_string(), Value::Null);
    }
    save_instance_credentials(state.clone(), &instance.id, &credentials)?;
    state
        .qr_logins
        .lock()
        .expect("qr login lock poisoned")
        .remove(&session_key);
    let _ = app.emit("credentials-changed", ());
    Ok(())
}

/// Qoder token 续期（ADR-0041）：`POST deviceToken/refresh {refresh_token}`，上游把
/// access 与 refresh **双双轮换**，所以两个槽必须一起写回；响应不含 user_id，
/// 首扫拿到的 uid 原样保留。失败返回 Err，旧 token 保留下轮再试
#[tauri::command]
pub async fn qoder_token_refresh(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<bool, String> {
    let instance = qr_instance_of(&state, &instance_id, "qoder")?;
    let device = qoder_device_site(&instance.site);
    let instance_credentials = {
        let vault = state.vault.lock().expect("vault lock poisoned");
        vault
            .credentials()?
            .get(&instance_id)
            .cloned()
            .unwrap_or(Value::Null)
    };
    let refresh_token = instances::instance_credential(&instance_credentials, "refreshToken")
        .ok_or_else(|| {
            format!(
                "缺少 {}，请重新扫码登录",
                instances::credential_label("qoder", "refreshToken").unwrap_or("refreshToken")
            )
        })?
        .to_string();
    let response = http_client()
        .post(format!("https://{}/api/v1/deviceToken/refresh", device.openapi))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {refresh_token}"))
        // 用 serde 拼体：refresh_token 是上游签发的值，手写转义一旦它含引号/反斜杠就成坏
        // JSON（该槽此前从没经过 qoder_access_token 那套字符集校验）
        .body(serde_json::json!({ "refresh_token": refresh_token }).to_string())
        .send()
        .await
        .map_err(|error| network_error_text(&error))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| network_error_text(&error))?;
    if !status.is_success() {
        return Err(format!(
            "Qoder token 续期失败（HTTP {}）：{}",
            status.as_u16(),
            truncate_error_body(&body)
        ));
    }
    let json: Value = serde_json::from_str(&body)
        .map_err(|error| format!("Qoder token 续期响应不是 JSON：{error}"))?;
    let access_token = json["device_token"].as_str().or_else(|| json["token"].as_str()).unwrap_or("");
    if access_token.is_empty() {
        return Err("Qoder token 续期响应缺少 token，旧 token 已保留".to_string());
    }
    let mut credentials = serde_json::json!({ "accessToken": access_token });
    if let Some(object) = credentials.as_object_mut() {
        for (slot, key) in [("refreshToken", "refresh_token"), ("expiresAt", "expires_at")] {
            if let Some(value) = json[key].as_str() {
                object.insert(slot.to_string(), Value::String(value.to_string()));
            }
        }
    }
    save_instance_credentials(state, &instance_id, &credentials)?;
    Ok(true)
}

/// 校验实例属于某个种类并返回它（三家扫码命令的公共前置，替代 WorkBuddy 那个同名私有函数）
fn qr_instance_of(
    state: &State<'_, AppState>,
    instance_id: &str,
    kind: &str,
) -> Result<db::StoredInstance, String> {
    let db = state.db.lock().expect("db lock poisoned");
    let instance = db
        .get_instance(instance_id)?
        .ok_or_else(|| "供应商实例不存在，请刷新后重试".to_string())?;
    if instance.provider_id != kind {
        return Err(format!("扫码登录仅支持 {kind} 实例"));
    }
    Ok(instance)
}

// ─── 小米 MiMo 扫码（ADR-0042）───

const MIMO_CONSOLE_ORIGIN: &str = "https://platform.xiaomimimo.com";
const MIMO_ACCOUNT_SITE: &str = "https://account.xiaomi.com";
const MIMO_SID: &str = "api-platform";

/// 小米的 JSON 响应带 `&&&START&&&` 前缀（真机实测），从第一个 `{` 起解
fn mimo_json(body: &str) -> Result<Value, String> {
    let start = body.find('{').ok_or_else(|| "小米响应不是 JSON".to_string())?;
    serde_json::from_str(&body[start..]).map_err(|error| format!("小米响应不是 JSON：{error}"))
}

/// 扫码会话用的 Cookie：deviceId 是我们自造的 `pc_<32hex>`，铸票与轮询都必须与
/// 登录时同一个（真机实测：sts 链里的 `d=` 参数就是它）
fn mimo_device_cookie(device_id: &str) -> String {
    format!("deviceId={device_id}; pass_ua=pc; uLocale=zh_CN")
}

fn mimo_new_device_id() -> String {
    let mut raw = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut raw);
    let hex: String = raw.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("pc_{hex}")
}

/// 发起 MiMo 扫码：serviceLogin 拿 qs/_sign → longPolling/loginUrl 签票据。
/// 票据主机每次轮转（ak. / c3. 前缀），故 lp 地址整条存进会话，不在本地重拼
#[tauri::command]
pub async fn mimo_qr_start(state: State<'_, AppState>, site: String) -> Result<QrStartResponse, String> {
    let device_id = mimo_new_device_id();
    let cookie = mimo_device_cookie(&device_id);
    let callback = format!("{MIMO_CONSOLE_ORIGIN}/sts");
    let login = http_client()
        .get(format!(
            "{MIMO_ACCOUNT_SITE}/pass/serviceLogin?sid={MIMO_SID}&_group=DEFAULT&_json=true&callback={}",
            urlencoding(&callback)
        ))
        .header("Accept", "application/json, text/plain, */*")
        .header("Cookie", &cookie)
        .send()
        .await
        .map_err(|error| network_error_text(&error))?;
    let login_body = login.text().await.map_err(|error| network_error_text(&error))?;
    let login_json = mimo_json(&login_body)?;
    // 裸探时这一趟回 code 70016「登录验证失败」是正常态（还没登录），qs/_sign/callback 照发
    let ticket_response = http_client()
        .get(format!("{MIMO_ACCOUNT_SITE}/longPolling/loginUrl"))
        .header("Accept", "application/json, text/plain, */*")
        .header("Cookie", &cookie)
        .query(&[
            ("_group", "DEFAULT"),
            ("_qrsize", "240"),
            ("qs", login_json["qs"].as_str().unwrap_or_default()),
            ("bizDeviceType", ""),
            ("callback", login_json["callback"].as_str().unwrap_or(&callback)),
            ("theme", ""),
            ("sid", MIMO_SID),
            ("needTheme", "false"),
            ("showActiveX", "false"),
            ("serviceParam", login_json["serviceParam"].as_str().unwrap_or_default()),
            ("_locale", "zh_CN"),
            ("_sign", login_json["_sign"].as_str().unwrap_or_default()),
        ])
        .send()
        .await
        .map_err(|error| network_error_text(&error))?;
    let ticket_body = ticket_response.text().await.map_err(|error| network_error_text(&error))?;
    let ticket = mimo_json(&ticket_body)?;
    let login_url = ticket["loginUrl"].as_str().unwrap_or_default();
    let poll_url = ticket["lp"].as_str().unwrap_or_default();
    if ticket["code"].as_i64() != Some(0) || login_url.is_empty() || poll_url.is_empty() {
        return Err(format!(
            "小米扫码票据签发失败：{}",
            ticket["description"]
                .as_str()
                .or(ticket["desc"].as_str())
                .filter(|value| !value.is_empty())
                .unwrap_or("上游未说明原因")
        ));
    }
    // 票据主机每次轮转（ak. / c3. / ak.lp.），这两个地址都来自上游响应：先过目的地面
    // 再存进会话，不给后面「带着 deviceId 打任意主机」留口子
    instances::validate_request_url("mimo", login_url)?;
    instances::validate_request_url("mimo", poll_url)?;
    // 票据有效期由上游给（实测 300 秒），加 30 秒余量覆盖最后一轮挂起；上限 15 分钟，
    // 不无条件信上游（会话是内存态，被拉长只会让放弃的凭据多驻留一阵）
    let ttl_ms = (ticket["timeout"].as_i64().unwrap_or(300).max(60) * 1000 + 30_000)
        .min(QR_LOGIN_DEFAULT_TTL_MS);
    let session_key = uuid::Uuid::new_v4().to_string();
    qr_session_store(
        &state,
        &session_key,
        QrLoginSession {
            kind: "mimo".to_string(),
            site,
            created_at: db::chrono_utc_now(),
            ttl_ms,
            secret: device_id,
            poll_url: poll_url.to_string(),
            credentials: None,
        },
    );
    Ok(QrStartResponse { auth_url: login_url.to_string(), session_key })
}

/// 轮询 MiMo 的 lp：这是**挂起式**长连接（上游一直挂着直到扫码确认或票据自身超时），
/// 所以一次调用最多等 75 秒，前端拿到 pending 就立刻再调一次，不需要固定间隔
#[tauri::command]
pub async fn mimo_qr_poll(
    state: State<'_, AppState>,
    session_key: String,
) -> Result<QrPollResponse, String> {
    let Some(session) = qr_session(&state, &session_key)? else {
        return Ok(QrPollResponse { status: "expired".to_string(), nickname: None, expires_at_ms: None });
    };
    if let Some(credentials) = &session.credentials {
        let nickname = instances::instance_credential(credentials, "nickname").map(String::from);
        return Ok(QrPollResponse { status: "confirmed".to_string(), nickname, expires_at_ms: None });
    }
    // 挂起连接被客户端超时掐断是**常态**（共享客户端 30 秒，上游票据 300 秒）：
    // 那一类错误按 pending 处理、由前端立刻续挂下一次；其余网络错误才可见报错。
    // 早先这里用 tokio 包一层 75 秒再给请求压一个 74 秒超时，结果 74 秒先到期
    // 把 pending 变成了硬错误，扫码慢一点就必然停表（代码审查 2026-10-10 指出）
    let response = match http_client()
        .get(&session.poll_url)
        .header("Accept", "application/json, text/plain, */*")
        .header("Cookie", mimo_device_cookie(&session.secret))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) if error.is_timeout() => {
            return Ok(QrPollResponse { status: "pending".to_string(), nickname: None, expires_at_ms: None })
        }
        Err(error) => return Err(network_error_text(&error)),
    };
    let body = response.text().await.map_err(|error| network_error_text(&error))?;
    let json = mimo_json(&body)?;
    let pass_token = json["passToken"].as_str().unwrap_or_default();
    if pass_token.is_empty() {
        return if json["code"].as_i64() == Some(0) {
            Ok(QrPollResponse { status: "pending".to_string(), nickname: None, expires_at_ms: None })
        } else {
            Ok(QrPollResponse { status: "expired".to_string(), nickname: None, expires_at_ms: None })
        };
    }
    let user_id = json["userId"].as_i64().map(|value| value.to_string()).unwrap_or_default();
    if user_id.is_empty() {
        return Err("小米登录成功但响应缺少 userId，请重新扫码".to_string());
    }
    let credentials = serde_json::json!({
        "passToken": pass_token,
        "userId": user_id,
        "deviceId": session.secret,
    });
    qr_session_store(
        &state,
        &session_key,
        // 确认即重置 TTL（同 qoder_qr_poll）：票据本身只有 300 秒，不重置的话用户从
        // 扫码到点保存的这几分钟里，已经拿到的 passToken 可能先到期被清掉
        QrLoginSession { credentials: Some(credentials), created_at: db::chrono_utc_now(), ..session },
    );
    Ok(QrPollResponse { status: "confirmed".to_string(), nickname: None, expires_at_ms: None })
}

/// 认领 MiMo 扫码产物：写 passToken 族并清空手贴的 serviceToken 槽（互斥，ADR-0035 同款）
#[tauri::command]
pub async fn mimo_qr_claim(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    session_key: String,
) -> Result<(), String> {
    let instance = qr_instance_of(&state, &instance_id, "mimo")?;
    let mut credentials = qr_staged_credentials(&state, &session_key)?;
    if let Some(object) = credentials.as_object_mut() {
        object.insert("serviceToken".to_string(), Value::Null);
    }
    save_instance_credentials(state.clone(), &instance.id, &credentials)?;
    state
        .qr_logins
        .lock()
        .expect("qr login lock poisoned")
        .remove(&session_key);
    let _ = app.emit("credentials-changed", ());
    Ok(())
}

/// 从一组 `Set-Cookie` 头里取 MiMo 的 serviceToken，**原样**返回（含 quoted-string 的引号）。
/// 取不到或内容过不了 cookie-value 字符集就回空串，由调用方判失败。
///
/// 小米落这个 Cookie 时用的是 RFC 6265 的 quoted-string（值带首尾双引号），而字符集白名单
/// 按标准排除 `"`——所以校验看的是剥掉引号的内部，返回的是上游原样。真机 200 的那次回发的
/// 就是带引号的值，剥引号发送未验证过，不擅自改。
fn pick_mimo_service_token<'a>(lines: impl Iterator<Item = &'a str>) -> String {
    for text in lines {
        let Some((name, rest)) = text.split_once('=') else {
            continue;
        };
        if name.trim() != instances::MIMO_SERVICE_TOKEN_COOKIE {
            continue;
        }
        let raw = rest.split(';').next().unwrap_or_default().trim();
        let inner = raw
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .unwrap_or(raw);
        if inner.is_empty() || inner.len() > 65_536 || !instances::is_cookie_value_chars(inner) {
            continue;
        }
        return raw.to_string();
    }
    String::new()
}

/// MiMo 扫码通道的铸票：passToken → `api-platform_serviceToken`。三步都是真机实测的形状，
/// 少任何一步都拿不到 cookie：
/// ① 无凭据打一次控制台 API，取它 401 回体**自述**的 loginUrl（内含服务方现签的 sign 与
///    followup）——自己拼一个无 sign 的 callback 只能拿到未登录态的 location，永远 401；
/// ② 带着 passToken 那族 cookie 走这条 loginUrl，已登录态回的是 **200 JSON**，
///    下一跳在响应体的 `location` 字段里（不是 302 头）；
/// ③ 跟到服务方的 /sts，它才把 serviceToken 种到 xiaomimimo.com 侧（307 那一跳的
///    Set-Cookie，会话级：既无 Max-Age 也无 Expires）。
/// ②③ 的目标地址都来自上游响应，因此逐跳过目的地面校验后才带凭据发出去
/// 铸票专用的 HTTP 客户端：**关掉自动重定向**。共享客户端会跟随跳转，而服务方 sts 的
/// 307 指向的 followup 写的是 `http://`（magpie 的注释点过这条），跟下去就被
/// `https_only` 挡成 "URL scheme is not allowed" 的 builder error——可是我们要的
/// serviceToken 恰好落在那个 307 自己的 Set-Cookie 上，根本不需要跟到 followup。
/// 重定向策略只能设在客户端上（RequestBuilder 没有这个开关），所以单开一个
fn mimo_mint_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .https_only(true)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent("AI Usage Tracker/0.1.0")
            .build()
            .expect("MiMo 铸票客户端初始化失败")
    })
}

async fn mimo_mint_service_token(pass: &instances::MimoPass) -> Result<String, String> {
    let account_cookie = format!(
        "{}; userId={}; passToken={}",
        mimo_device_cookie(&pass.device_id),
        pass.user_id,
        pass.pass_token
    );
    // ① 服务方自述的登录入口（无凭据，不带任何 cookie）
    let probe = mimo_mint_client()
        .get(format!("{MIMO_CONSOLE_ORIGIN}/api/v1/balance"))
        .header("Accept", "application/json, text/plain, */*")
        .send()
        .await
        .map_err(|error| network_error_text(&error))?;
    let probe_body = probe.text().await.map_err(|error| network_error_text(&error))?;
    let probe_json: Value = serde_json::from_str(&probe_body)
        .map_err(|_| "MiMo 登录入口探测失败：响应不是 JSON".to_string())?;
    let login_url = probe_json["loginUrl"].as_str().unwrap_or_default();
    if login_url.is_empty() {
        return Err("MiMo 铸票失败：控制台没有给出登录入口".to_string());
    }

    // ② 带 passToken 走它，取下一跳（已登录态在 200 JSON 的 location 里，也容 302 头）
    let separator = if login_url.contains('?') { '&' } else { '?' };
    let authorized_url = format!("{login_url}{separator}_json=true");
    // 校验的是**真正发出去的那条串**，不是拼接前的原料
    instances::validate_request_url("mimo", &authorized_url)?;
    let authorized = mimo_mint_client()
        .get(&authorized_url)
        .header("Accept", "application/json, text/plain, */*")
        .header("Cookie", &account_cookie)
        .send()
        .await
        .map_err(|error| network_error_text(&error))?;
    let authorized_headers = authorized.headers().clone();
    let authorized_body = authorized
        .text()
        .await
        .map_err(|error| network_error_text(&error))?;
    let authorized_json = mimo_json(&authorized_body).unwrap_or(Value::Null);
    let next = authorized_json["location"]
        .as_str()
        .map(String::from)
        .or_else(|| {
            authorized_headers
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .map(String::from)
        })
        .unwrap_or_default();
    // 服务方给的是 http 时按它自己的域升到 https（session cookie 只在 https 回传）
    let sts_url = if next.starts_with("http://platform.xiaomimimo.com") {
        next.replacen("http://", "https://", 1)
    } else {
        next
    };
    if sts_url.is_empty() {
        return Err(
            "MiMo 铸票失败：小米账号没有回授权跳转（passToken 可能已失效，请重新扫码）".to_string(),
        );
    }
    instances::validate_request_url("mimo", &sts_url)?;

    // ③ 跟到服务方 /sts，读它 Set-Cookie 里的 serviceToken（这一跳不带 cookie：
    // 真机实测服务方按 URL 里的 sign 认，passport cookie 属于另一个域）
    let sts_response = mimo_mint_client()
        .get(&sts_url)
        .header("Accept", "*/*")
        .send()
        .await
        .map_err(|error| network_error_text(&error))?;
    let service_token = pick_mimo_service_token(
        sts_response
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok()),
    );
    if service_token.is_empty() {
        return Err(
            "MiMo 铸票失败：授权跳转没有落下可用的 serviceToken（passToken 可能已失效，请重新扫码）".to_string(),
        );
    }
    Ok(service_token)
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
pub fn hide_glance_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("glance") {
        window.hide().map_err(|error| error.to_string())?;
        // 记录隐藏时刻：随后到达的托盘单击视为 blur 自动隐藏的同一交互（ADR-0016）
        let state = app.state::<crate::tray_scheme::TrayState>();
        *state
            .glance_hidden_at
            .lock()
            .expect("glance hidden lock poisoned") = Some(std::time::Instant::now());
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
    fn report_placeholders_survive_quote_ending_nickname() {
        // 尾引号昵称：strip_prefix/suffix 各剥一层，`\"` 转义序列保持完整，
        // 事件体 JSON 不被裸反斜杠扭弯（安全审查：trim_matches 会剥掉它）
        let filled = workbuddy_fill_report_placeholders(
            r#"{"userNickname":"{{WB_NICKNAME}}","userId":"{{WB_UID}}"}"#,
            "uid-1",
            r#"abc""#,
        );
        assert_eq!(filled, r#"{"userNickname":"abc\"","userId":"uid-1"}"#);
        // 解析回验证 JSON 完整性
        let parsed: serde_json::Value = serde_json::from_str(&filled).expect("filled body must be valid JSON");
        assert_eq!(parsed["userNickname"], r#"abc""#);
        assert_eq!(parsed["userId"], "uid-1");
    }

    #[test]
    fn report_placeholders_fill_device_ids_deterministically() {
        let filled = workbuddy_fill_report_placeholders(
            r#"{"m":"{{WB_MACHINE_ID}}","s":"{{WB_SESSION_ID}}","w":"{{WB_WEB_MACHINE_ID}}"}"#,
            "uid-1",
            "",
        );
        let parsed: serde_json::Value = serde_json::from_str(&filled).expect("valid JSON");
        for key in ["m", "s", "w"] {
            let id = parsed[key].as_str().expect("device id is a string");
            assert_eq!(id.len(), 36, "36 hex chars");
            assert!(id.chars().all(|c| c.is_ascii_hexdigit()), "hex only: {id}");
        }
        // 同一 uid 恒定同一标识（machine 与 session salt 不同所以值不同）
        assert_ne!(parsed["m"], parsed["s"]);
        let again = workbuddy_fill_report_placeholders(
            r#"{"m":"{{WB_MACHINE_ID}}"}"#,
            "uid-1",
            "",
        );
        let parsed_again: serde_json::Value = serde_json::from_str(&again).expect("valid JSON");
        assert_eq!(parsed["m"], parsed_again["m"]);
    }

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
        // 展示名在 debug 构建（开发实例）携带 (dev) 后缀，随构建分流断言（ADR-0018）
        let suffix = dev_suffix();
        assert_eq!(tray_tooltip("zh", false), format!("AI 用量助手{suffix}"));
        assert_eq!(tray_tooltip("zh", true), format!("AI 用量助手 — 有额度告警{suffix}"));
        assert_eq!(tray_tooltip("en", false), format!("AI Usage Tracker{suffix}"));
        assert_eq!(tray_tooltip("en", true), format!("AI Usage Tracker — quota alert{suffix}"));
        assert_eq!(app_title("zh"), format!("AI 用量助手{suffix}"));
        assert_eq!(app_title("en"), format!("AI Usage Tracker{suffix}"));
    }

    /// 授权链接与轮询地址的百分号编码：入参是 base64url（可能带 `+` `/` `=`）与 uuid，
    /// `+` 在 query 里会被解成空格、`=`/`&` 会截断参数，编码错就是整条流程起不来
    #[test]
    fn urlencoding_covers_the_characters_pkce_produces() {
        assert_eq!(urlencoding("abcABC123-._~"), "abcABC123-._~");
        assert_eq!(urlencoding("a+b/c=d"), "a%2Bb%2Fc%3Dd");
        assert_eq!(urlencoding("qoder-work-cn://"), "qoder-work-cn%3A%2F%2F");
        assert_eq!(urlencoding("e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb"), "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb");
    }

    /// 铸票取 serviceToken：小米落的是 quoted-string（值带首尾引号），校验看剥引号后的
    /// 内部、返回原样。2026-10-09 应用内首跑就是被「按白名单拒 `"`」这条自己的守卫判死的
    #[test]
    fn mimo_service_token_keeps_the_quoted_string_as_is() {
        let quoted = ["api-platform_serviceToken=\"6OFabc==\"; Path=/; HttpOnly; Version=1"];
        assert_eq!(
            pick_mimo_service_token(quoted.iter().copied()),
            "\"6OFabc==\"".to_string()
        );
        // 不带引号的形态（DevTools 里看到的就是剥了引号的）也照原样收，两种都发过
        let bare = ["api-platform_serviceToken=6OFabc==; Path=/"];
        assert_eq!(pick_mimo_service_token(bare.iter().copied()), "6OFabc==".to_string());
        // 别的 Cookie 不算数（同批还有 slh/ph/userId，名字都带 api-platform_ 前缀）
        let others = [
            "api-platform_slh=\"PNY8=\"; Path=/",
            "userId=123456789; Path=/",
            "api-platform_serviceToken=; Path=/",
        ];
        assert_eq!(pick_mimo_service_token(others.iter().copied()), "");
        // 值里带 CRLF 或空格的一律不收：这道关是拼头前的注入防线，不因引号而放宽
        let dirty = ["api-platform_serviceToken=\"ab\rc\"; Path=/"];
        assert_eq!(pick_mimo_service_token(dirty.iter().copied()), "");
    }

    /// 网络失败文案按类别取摘要：连接超时优先于请求超时（两个谓词同时为真是连接阶段超时），
    /// 传输中断兜底在前两类之外；reqwest::Error 无公开构造器，只测纯函数映射
    #[test]
    fn network_error_summary_classifies_by_flags() {
        assert_eq!(
            network_error_summary(true, true, false),
            "连接超时（10 秒内未能建立连接）"
        );
        assert_eq!(
            network_error_summary(true, false, false),
            "请求超时（30 秒内服务端未完成响应）"
        );
        assert_eq!(
            network_error_summary(false, true, false),
            "连接失败（DNS 解析、TLS 或网络不可达）"
        );
        assert_eq!(
            network_error_summary(false, false, true),
            "传输中断（连接被服务端或网络中途断开）"
        );
        assert_eq!(network_error_summary(false, false, false), "网络请求失败");
    }

    #[test]
    fn normalizes_opencode_go_cookie_inputs() {
        assert_eq!(
            opencode_cookie_header(" abc ").unwrap(),
            "__Host-console_session=abc"
        );
        assert_eq!(
            opencode_cookie_header("st_TEST-session-0000").unwrap(),
            "__Host-console_session=st_TEST-session-0000"
        );
        // base64 padding 不应让裸值被误判成整段 Cookie 头
        assert_eq!(
            opencode_cookie_header("st_TEST-session-0000==").unwrap(),
            "__Host-console_session=st_TEST-session-0000=="
        );
        assert_eq!(
            opencode_cookie_header("Fe26.2**abc==").unwrap(),
            "auth=Fe26.2**abc=="
        );
        assert_eq!(
            opencode_cookie_header("Fe26.2**abc").unwrap(),
            "auth=Fe26.2**abc"
        );
        assert_eq!(opencode_cookie_header("auth=abc").unwrap(), "auth=abc");
        assert_eq!(opencode_cookie_header("AUTH=abc").unwrap(), "auth=abc");
        assert_eq!(opencode_cookie_header("Cookie: auth=abc").unwrap(), "auth=abc");
        assert_eq!(
            opencode_cookie_header("foo=1; auth=abc; bar=2").unwrap(),
            "auth=abc"
        );
        assert_eq!(
            opencode_cookie_header("auth=abc; __Host-console_session=def").unwrap(),
            "auth=abc; __Host-console_session=def"
        );
        assert_eq!(
            opencode_cookie_header("__HOST-CONSOLE_SESSION=def").unwrap(),
            "__Host-console_session=def"
        );
        // 同名重复只留第一份，避免把两条 auth 拼进同一个头
        assert_eq!(
            opencode_cookie_header("auth=a; auth=b").unwrap(),
            "auth=a"
        );
        // 没有 OpenCode 认的键、值里带换行（头注入）、或可识别键为空值一律拒绝
        assert!(opencode_cookie_header("foo=1").is_err());
        assert!(opencode_cookie_header("auth=abc\r\nX-Injected: 1").is_err());
        assert!(opencode_cookie_header("auth=; __Host-console_session=def").is_err());
        assert!(opencode_cookie_header("__Host-console_session=").is_err());
        // 三个键都在白名单内；超长整头拒绝
        assert_eq!(
            opencode_cookie_header("__Host-auth=abc").unwrap(),
            "__Host-auth=abc"
        );
        let overlong = format!("auth={}", "a".repeat(MAX_OPENCODE_COOKIE_HEADER_LENGTH));
        assert!(opencode_cookie_header(&overlong).is_err());
    }

    #[test]
    fn instance_patch_deserializes_threshold_semantics() {
        let absent: InstancePatch = serde_json::from_str(r#"{"note":"x"}"#).unwrap();
        assert!(absent.threshold.is_none());
        assert!(absent.balance_threshold.is_none());

        let cleared: InstancePatch = serde_json::from_str(r#"{"threshold":null}"#).unwrap();
        assert_eq!(cleared.threshold, Some(None));

        let set: InstancePatch = serde_json::from_str(r#"{"threshold":42}"#).unwrap();
        assert_eq!(set.threshold, Some(Some(42.0)));

        let balance_cleared: InstancePatch =
            serde_json::from_str(r#"{"balanceThreshold":null}"#).unwrap();
        assert_eq!(balance_cleared.balance_threshold, Some(None));

        let balance_set: InstancePatch =
            serde_json::from_str(r#"{"balanceThreshold":5.5}"#).unwrap();
        assert_eq!(balance_set.balance_threshold, Some(Some(5.5)));
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

    /// reqwest 的 `RequestBuilder::header` 是 append（同名并存两条、先到的被网关读到），
    /// 所以「凭据只由鉴权分支写入」必须靠按名字剔除调用方传入的同名头来保证
    #[test]
    fn caller_supplied_credential_headers_are_dropped() {
        assert!(is_reserved_credential_header("Cookie"));
        assert!(is_reserved_credential_header("cookie"));
        assert!(is_reserved_credential_header("USER-AGENT"));
        assert!(is_reserved_credential_header("Authorization"));
        assert!(!is_reserved_credential_header("Referer"));
        assert!(!is_reserved_credential_header("X-Requested-With"));

        let mut headers = HashMap::new();
        headers.insert("cookie".to_string(), "attacker=1".to_string());
        headers.insert("User-Agent".to_string(), "spoofed".to_string());
        headers.insert("Origin".to_string(), "https://qoder.com".to_string());
        headers.retain(|name, _| !is_reserved_credential_header(name));
        assert_eq!(headers.len(), 1, "只留下静态协议头");
        assert!(headers.contains_key("Origin"));
    }

    #[test]
    fn qoder_session_value_rejects_separators_control_and_non_ascii() {
        assert!(validate_qoder_session_value("qoder_session_cookie_value").is_ok());
        // base64/JWT 形态的值（= padding 与 | . - _ 都是 cookie-value 合法字符）
        assert!(validate_qoder_session_value("eyJhbGci.eyJzdWIiOjF9==").is_ok());
        assert!(validate_qoder_session_value("k7Qx2mZp|1790000000|-_ab12CD").is_ok());
        // 整段 Cookie 头（分号 + 空格）不是「单个值」
        assert!(validate_qoder_session_value("session=abc; session_2=def").is_err());
        assert!(validate_qoder_session_value("a=1\r\nX-Evil: 1").is_err());
        assert!(validate_qoder_session_value("a=1\nb=2").is_err());
        assert!(validate_qoder_session_value("a=中文").is_err());
        assert!(validate_qoder_session_value("a=\t1").is_err());
        assert!(validate_qoder_session_value("\"abc\"").is_err());
        assert!(validate_qoder_session_value("a,b").is_err());
        assert!(validate_qoder_session_value("").is_err());
    }
}
