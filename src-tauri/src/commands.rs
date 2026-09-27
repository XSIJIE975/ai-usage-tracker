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
    if !value.chars().all(|c| {
        c == '!'
            || ('\u{23}'..='\u{2b}').contains(&c)
            || ('\u{2d}'..='\u{3a}').contains(&c)
            || ('\u{3c}'..='\u{7e}').contains(&c)
    }) {
        return Err(());
    }
    Ok(())
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

/// 用"刚输入、尚未保存"的凭据值发起一次真实探测请求，验证连通性。
/// auth: "bearer"（携带 credential 作为 Bearer token）| "cookie"（auth=<normalized credential>）
/// session_triple：WorkBuddy 的 session / session_2 / 登录 UA 三个值——走与 provider_request
/// 的 session_cookie 通道同一个拼装与校验入口；给出时忽略 auth/credential
#[tauri::command]
pub async fn diagnose_request(
    url: String,
    auth: Option<String>,
    credential: Option<String>,
    expect_html: Option<bool>,
    session_triple: Option<WorkbuddySessionInput>,
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
                let normalized = normalize_auth_cookie(&cookie);
                request = request.header("Cookie", format!("auth={normalized}"));
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

/// WorkBuddy 签到通知判重水合：None = 该实例从未通知过签到
#[tauri::command]
pub fn get_workbuddy_checkin(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<Option<db::StoredWorkbuddyCheckin>, String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.get_workbuddy_checkin(&instance_id)
}

/// WorkBuddy 签到通知判重回写：重启/F5 后据此恢复「每天只通知一次」
#[tauri::command]
pub fn save_workbuddy_checkin(
    state: State<'_, AppState>,
    checkin: db::StoredWorkbuddyCheckin,
) -> Result<(), String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.save_workbuddy_checkin(&checkin)
}

/// WorkBuddy 旅行领奖通知判重水合：None = 该实例从未通知过领奖
#[tauri::command]
pub fn get_workbuddy_travel_claim(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<Option<db::StoredWorkbuddyTravelClaim>, String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.get_workbuddy_travel_claim(&instance_id)
}

/// WorkBuddy 旅行领奖通知判重回写：按行程键判重，重启/F5 后不重复通知同一趟到账
#[tauri::command]
pub fn save_workbuddy_travel_claim(
    state: State<'_, AppState>,
    claim: db::StoredWorkbuddyTravelClaim,
) -> Result<(), String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.save_workbuddy_travel_claim(&claim)
}

/// WorkBuddy 管家通知判重水合：None = 该实例从未通知过管家闭环事件
#[tauri::command]
pub fn get_workbuddy_growth_notice(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<Option<db::StoredWorkbuddyGrowthNotice>, String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.get_workbuddy_growth_notice(&instance_id)
}

/// WorkBuddy 管家通知判重回写：按日判重（一轮多事件汇总一条），重启/F5 后当日不重报
#[tauri::command]
pub fn save_workbuddy_growth_notice(
    state: State<'_, AppState>,
    notice: db::StoredWorkbuddyGrowthNotice,
) -> Result<(), String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.save_workbuddy_growth_notice(&notice)
}

/// WorkBuddy 试用加油包通知判重水合：None = 该实例从未通知过领取
#[tauri::command]
pub fn get_workbuddy_trial(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<Option<db::StoredWorkbuddyTrial>, String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.get_workbuddy_trial(&instance_id)
}

/// WorkBuddy 试用加油包通知判重回写：一次性事件实例级一行，重启/F5 后不重报
#[tauri::command]
pub fn save_workbuddy_trial(
    state: State<'_, AppState>,
    trial: db::StoredWorkbuddyTrial,
) -> Result<(), String> {
    let db = state.db.lock().expect("db lock poisoned");
    db.save_workbuddy_trial(&trial)
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
