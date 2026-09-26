use serde_json::Value;

use crate::db::{chrono_utc_now, Db, StoredInstance};
use crate::vault::Vault;

/// 供应商种类的内置顺序（与前端 providerModules 一致），迁移时决定初始 sort_order。
/// 每项为 (种类, [(旧扁平凭据键, 凭据槽名)])。
pub const PROVIDER_KINDS: &[(&str, &[(&str, &str)])] = &[
    (
        "opencode-go",
        &[
            ("opencodeGoWorkspaceId", "workspaceId"),
            ("opencodeGoAuthCookie", "cookie"),
            ("opencodeGoApiKey", "apiKey"),
        ],
    ),
    (
        "deepseek",
        &[
            ("deepseekApiKey", "apiKey"),
            ("deepseekUserToken", "userToken"),
        ],
    ),
    ("glm", &[("glmCodingPlanKey", "planKey")]),
    // workbuddy 的旧扁平键是「Copy as cURL」原文，与现在的三槽形态不同源（ADR-0029），
    // 刻意不映射：升级后该格空着，快照点名要求重填三项，比猜着拆旧值更诚实
    ("workbuddy", &[]),
    // qoder 晚于实例化改造加入（ADR-0030），无旧扁平凭据键需要迁移
    ("qoder", &[]),
];

/// (kind, slot) 组合的人类可读凭据名，用于缺凭据时的报错文案
pub fn credential_label(kind: &str, slot: &str) -> Option<&'static str> {
    match (kind, slot) {
        ("deepseek", "apiKey") => Some("DeepSeek API Key"),
        ("deepseek", "userToken") => Some("DeepSeek UserToken"),
        ("opencode-go", "workspaceId") => Some("OpenCode Go Workspace ID"),
        ("opencode-go", "cookie") => Some("OpenCode Auth Cookie"),
        ("opencode-go", "apiKey") => Some("OpenCode Go API Key"),
        ("glm", "planKey") => Some("智谱 Coding Plan API Key"),
        ("workbuddy", "session") => Some("WorkBuddy session"),
        ("workbuddy", "session2") => Some("WorkBuddy session_2"),
        ("workbuddy", "userAgent") => Some("WorkBuddy 浏览器 User-Agent"),
        ("qoder", "cookie") => Some("Qoder 会话 Cookie 值"),
        _ => None,
    }
}

/// 拼好的 WorkBuddy 鉴权头：Cookie 头与登录 UA，只由 session_cookie 通道使用
#[derive(Debug)]
pub struct WorkbuddySession {
    pub cookie_header: String,
    pub user_agent: String,
}

/// 单个 Cookie 值上限：实测 session 近 4000 字符、session_2 近 2000 字符
const MAX_COOKIE_VALUE_LENGTH: usize = 65_536;
/// UA 上限：主流浏览器 UA 不足 200 字符，超出即视为误粘了整段请求
const MAX_USER_AGENT_LENGTH: usize = 512;

/// 从三槽解析出鉴权头。三点都必需，缺哪一点名哪一槽——0.9.0 的「只发 session」与
/// 0.9.x 的「UA 用内置常量兜底」都被实测否决过（前者 401、后者浏览器一升版就 401），
/// 所以这里宁缺不猜：报错可见（ADR-0024），出路是回设置重填
pub fn workbuddy_session(credentials: &Value) -> Result<WorkbuddySession, String> {
    let session = validate_cookie_value(required_workbuddy_slot(credentials, "session")?)?;
    let session2 = validate_cookie_value(required_workbuddy_slot(credentials, "session2")?)?;
    let user_agent = validate_user_agent(required_workbuddy_slot(credentials, "userAgent")?)?;
    Ok(WorkbuddySession {
        cookie_header: format!("session={session}; session_2={session2}"),
        user_agent,
    })
}

fn required_workbuddy_slot<'a>(credentials: &'a Value, slot: &str) -> Result<&'a str, String> {
    instance_credential(credentials, slot).ok_or_else(|| {
        format!(
            "缺少 {}",
            credential_label("workbuddy", slot).unwrap_or(slot)
        )
    })
}

/// RFC 6265 cookie-value 字符集（可见 ASCII，排除空白、`"`、`,`、`;`）与长度上限。
/// 凭据是用户填的外部输入，拼进请求头之前必须先过这关——白名单同时挡住 CRLF 头注入
/// （字符集与前端 `providers/workbuddy.ts`、qoder 的同款校验逐字符一致，任一处收紧都会
/// 误伤真机凭据）
fn validate_cookie_value(value: &str) -> Result<String, String> {
    if value.is_empty() {
        return Err("WorkBuddy session Cookie 的值为空".to_string());
    }
    if value.len() > MAX_COOKIE_VALUE_LENGTH {
        return Err("WorkBuddy Cookie 值过长，请确认只粘贴了该 Cookie 的值".to_string());
    }
    if !value.chars().all(|c| {
        c == '!'
            || ('\u{23}'..='\u{2b}').contains(&c)
            || ('\u{2d}'..='\u{3a}').contains(&c)
            || ('\u{3c}'..='\u{7e}').contains(&c)
    }) {
        return Err(
            "WorkBuddy Cookie 值包含非法字符（不能带空格、引号、分号或控制符）".to_string(),
        );
    }
    Ok(value.to_string())
}

/// UA 校验：浏览器 UA 是纯可见 ASCII；挡 CRLF 注入与误粘的整段请求
fn validate_user_agent(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("WorkBuddy 浏览器 User-Agent 的值为空".to_string());
    }
    if value.len() > MAX_USER_AGENT_LENGTH {
        return Err(format!(
            "User-Agent 过长（{} 字符），请只粘贴 User-Agent 那一行的值",
            value.len()
        ));
    }
    if !value.chars().all(|c| ('\u{20}'..='\u{7e}').contains(&c)) {
        return Err("User-Agent 包含非法字符（不能带换行或非 ASCII）".to_string());
    }
    Ok(value.to_string())
}

/// 站点取值校验（仅 qoder 使用，ADR-0030）：china 中国站 / international 国际站
pub fn validate_site(site: &str) -> Result<(), String> {
    match site {
        "china" | "international" => Ok(()),
        other => Err(format!("不支持的站点：{other}")),
    }
}

/// bearer auth 缺省凭据槽：各种类的主鉴权键
pub fn default_bearer_slot(kind: &str) -> Option<&'static str> {
    match kind {
        "deepseek" => Some("apiKey"),
        "opencode-go" => Some("apiKey"),
        "glm" => Some("planKey"),
        _ => None,
    }
}

/// 各种类允许的目标域名（目的地面，ADR-0032）：凭据头只由本进程注入，那么
/// 「凭据会被发去哪个域」也必须由本进程决定，不能跟着调用方传来的 url 走。
/// 与 `credential_label` 同形，接新供应商时两张表各登记一行；本表与前端 URL 常量
/// 的对齐由 `src/providers/allowed-hosts.test.ts` 守住，漂移时测试红。
const ALLOWED_HOSTS: &[(&str, &[&str])] = &[
    (
        "deepseek",
        &["api.deepseek.com", "platform.deepseek.com"],
    ),
    ("opencode-go", &["opencode.ai"]),
    ("glm", &["open.bigmodel.cn", "www.bigmodel.cn"]),
    (
        "workbuddy",
        &["www.workbuddy.cn", "www.workbuddy.ai"],
    ),
    ("qoder", &["qoder.com.cn", "qoder.com"]),
];

/// 该种类允许的目标域名；未登记的种类返回 None，调用方按拒绝处理
/// （宁可刷新失败，也不把凭据发往未登记的目的地）
pub fn allowed_hosts(kind: &str) -> Option<&'static [&'static str]> {
    ALLOWED_HOSTS
        .iter()
        .find(|(name, _)| *name == kind)
        .map(|(_, hosts)| *hosts)
}

/// 目的地面校验：只放 https、只放登记表内的精确主机名，且不接受 userinfo 与端口。
/// 主机名精确比对而非后缀匹配——`www.workbuddy.cn.evil.com` 这类以允许域结尾的地址
/// 必须被拒；带尾点的 FQDN 同样不匹配即拒，属 fail-closed（前端常量里不存在这种写法）
fn check_request_url(url: &str, allowed: &[&str]) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| format!("请求地址无法解析：{url}"))?;
    if parsed.scheme() != "https" {
        return Err(format!("只允许 https 请求：{url}"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!("请求地址不允许携带用户名或密码：{url}"));
    }
    if parsed.port().is_some() {
        return Err(format!("请求地址不允许指定端口：{url}"));
    }
    let host = parsed.host_str().unwrap_or_default();
    if !allowed.iter().any(|item| *item == host) {
        return Err(format!(
            "拒绝向 {host} 发请求：不在允许的域名表内（{}）",
            allowed.join("、")
        ));
    }
    Ok(())
}

/// provider_request 用：按实例所属种类收窄。跨种类端点（拿 glm 的 key 去打
/// workbuddy.cn）同样拒绝——凭据离开它所属的供应商就算泄露
pub fn validate_request_url(kind: &str, url: &str) -> Result<(), String> {
    let allowed = match allowed_hosts(kind) {
        Some(allowed) => allowed,
        None => {
            return Err(format!(
                "供应商种类 {kind} 未登记允许的目标域名，拒绝发请求（请在 ALLOWED_HOSTS 补登记）"
            ))
        }
    };
    check_request_url(url, allowed)
}

/// diagnose_request 用：探测没有实例上下文（凭据是用户刚粘贴、尚未保存的那一份），
/// 只能取五个种类的全集；它不带 vault 里的凭据，全集因此不构成额外泄露面
pub fn validate_probe_url(url: &str) -> Result<(), String> {
    let hosts: Vec<&str> = ALLOWED_HOSTS
        .iter()
        .flat_map(|(_, list)| list.iter().copied())
        .collect();
    check_request_url(url, &hosts)
}

/// 从 vault 的某实例凭据 map 中取出非空字符串槽位值
pub fn instance_credential<'a>(instance_credentials: &'a Value, slot: &str) -> Option<&'a str> {
    instance_credentials
        .get(slot)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

/// 一次性迁移：内层 v1 扁平凭据 → provider_instances 表 + v2 按实例嵌套。
/// 幂等：内层已是 v2 直接返回；凭据库未解锁（如待主密码迁移）时跳过，
/// 由 vault_migrate 完成后再次调用。旧实例 id 沿用种类字符串（deepseek 等），
/// 历史快照与通知的 provider_id 列已被 RENAME COLUMN 原样继承。
pub fn migrate_to_instances(vault: &mut Vault, db: &Db) -> Result<(), String> {
    if !vault.is_unlocked() {
        return Ok(());
    }
    if vault.inner_version() == Some(2) {
        return Ok(());
    }
    let flat = vault.credentials()?.clone();
    let settings = db.get_settings().unwrap_or_else(|_| serde_json::json!({}));
    let now = chrono_utc_now();

    let mut instances = serde_json::Map::new();
    for (index, (kind, slot_map)) in PROVIDER_KINDS.iter().enumerate() {
        let mut slots = serde_json::Map::new();
        for (legacy_key, slot) in *slot_map {
            if let Some(value) = flat.get(*legacy_key) {
                slots.insert(slot.to_string(), value.clone());
            }
        }
        if slots.is_empty() {
            continue;
        }
        // 只给「已有凭据」的种类建实例；阈值与自动刷新从旧 settings 字段继承
        let threshold = legacy_threshold(&settings, kind);
        let auto_refresh = settings
            .get("providers")
            .and_then(|providers| providers.get(*kind))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        db.insert_instance(
            &StoredInstance {
                id: kind.to_string(),
                provider_id: kind.to_string(),
                note: String::new(),
                sort_order: index as i64,
                pinned: false,
                auto_refresh,
                threshold,
                balance_threshold: None,
                // 迁移时代 qoder 尚不存在，缺省中国站无副作用（仅 qoder 消费该字段）
                site: "china".to_string(),
                created_at: now,
            },
            true,
        )?;
        instances.insert(kind.to_string(), Value::Object(slots));
    }

    vault.save_credentials(&Value::Object(instances))?;

    // 两个旧字段已被实例表取代，从 settings blob 中移除
    if let Some(settings_object) = settings.as_object() {
        let mut next = settings_object.clone();
        next.remove("providers");
        next.remove("alertThresholds");
        db.save_settings(&Value::Object(next))?;
    }
    Ok(())
}

/// 旧 settings.alertThresholds → 各种类阈值：DeepSeek 为元、其余为已用百分比
fn legacy_threshold(settings: &Value, kind: &str) -> Option<f64> {
    let thresholds = settings.get("alertThresholds")?;
    let key = match kind {
        "deepseek" => "deepseekBalanceBelowCny",
        "opencode-go" => "opencodeMonthlyUsedPercent",
        "glm" => "glmQuotaUsedPercent",
        _ => return None,
    };
    thresholds.get(key).and_then(Value::as_f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{derive_legacy_key, encrypt, KeyStore};
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine as _;
    use rand::RngCore;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Clone, Default)]
    struct MemoryKeyStore {
        secret: Arc<Mutex<Option<Vec<u8>>>>,
    }

    impl KeyStore for MemoryKeyStore {
        fn load(&self) -> Result<Option<Vec<u8>>, String> {
            Ok(self.secret.lock().unwrap().clone())
        }
        fn store(&self, key: &[u8]) -> Result<(), String> {
            *self.secret.lock().unwrap() = Some(key.to_vec());
            Ok(())
        }
    }

    fn temp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-usage-instances-test-{tag}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn open_vault_and_db(tag: &str) -> (Vault, Db) {
        let dir = temp_path(tag);
        let mut vault = Vault::new(dir.join("vault.json"), Box::new(MemoryKeyStore::default()));
        vault.open().unwrap();
        (vault, Db::open(&dir.join("test.db")).unwrap())
    }

    /// 构造「外层 v1 主密码 + 内层 v1 扁平凭据」的历史 vault，再走 migrate 解锁——
    /// 这正是存量用户升级前的真实状态（0.3.0 的 vault 外层已是 v2、内层仍是 v1）
    fn legacy_unlocked_vault(tag: &str, credentials: Value) -> (Vault, Db) {
        let dir = temp_path(tag);
        let path = dir.join("vault.json");
        let salt = random_bytes(16);
        let nonce = random_bytes(12);
        let key = derive_legacy_key("correct-horse", &salt).unwrap();
        let payload = json!({ "version": 1, "credentials": credentials });
        let ciphertext =
            encrypt(&key, &nonce, &serde_json::to_vec(&payload).unwrap()).unwrap();
        let file = json!({
            "version": 1,
            "kdf": "argon2id",
            "salt": BASE64.encode(&salt),
            "nonce": BASE64.encode(&nonce),
            "ciphertext": BASE64.encode(&ciphertext),
        });
        std::fs::write(&path, serde_json::to_vec_pretty(&file).unwrap()).unwrap();

        let mut vault = Vault::new(path, Box::new(MemoryKeyStore::default()));
        vault.open().unwrap();
        vault.migrate("correct-horse").unwrap();
        (vault, Db::open(&dir.join("test.db")).unwrap())
    }

    fn random_bytes(len: usize) -> Vec<u8> {
        let mut bytes = vec![0u8; len];
        rand::thread_rng().fill_bytes(&mut bytes);
        bytes
    }

    #[test]
    fn migrates_flat_credentials_into_kind_instances() {
        let (mut vault, db) = legacy_unlocked_vault(
            "flat",
            json!({
                "deepseekApiKey": "sk-1",
                "deepseekUserToken": "tok-1",
                "opencodeGoAuthCookie": "cookie-1",
                "glmWebToken": "已废弃的旧凭据"
            }),
        );
        db.save_settings(&json!({
            "refreshEnabled": true,
            "providers": { "opencode-go": false, "deepseek": true },
            "alertThresholds": {
                "deepseekBalanceBelowCny": 30,
                "opencodeMonthlyUsedPercent": 75,
                "glmQuotaUsedPercent": 90
            },
            "alertsEnabled": true
        }))
        .unwrap();

        migrate_to_instances(&mut vault, &db).unwrap();

        // 只给有凭据的 deepseek / opencode-go 建实例（glm 无凭据、WebToken 不算）
        let instances = db.list_instances().unwrap();
        assert_eq!(
            instances
                .iter()
                .map(|i| i.id.as_str())
                .collect::<Vec<_>>(),
            vec!["opencode-go", "deepseek"],
            "sort_order 按内置种类顺序：opencode-go 在前"
        );
        let deepseek = db.get_instance("deepseek").unwrap().unwrap();
        assert_eq!(deepseek.threshold, Some(30.0));
        assert!(deepseek.auto_refresh);
        let opencode = db.get_instance("opencode-go").unwrap().unwrap();
        assert_eq!(opencode.threshold, Some(75.0));
        assert!(!opencode.auto_refresh, "继承 settings.providers 中关闭的开关");

        // vault 内层升 v2，槽位改名，废弃键不带入
        assert_eq!(vault.inner_version(), Some(2));
        let credentials = vault.credentials().unwrap();
        assert_eq!(credentials["deepseek"]["apiKey"], json!("sk-1"));
        assert_eq!(credentials["deepseek"]["userToken"], json!("tok-1"));
        assert_eq!(credentials["opencode-go"]["cookie"], json!("cookie-1"));
        assert!(credentials["opencode-go"].get("workspaceId").is_none());
        assert!(credentials.get("glm").is_none());
        assert!(credentials.to_string().find("WebToken").is_none());

        // settings 旧字段剥除，其余保留
        let settings = db.get_settings().unwrap();
        assert!(settings.get("providers").is_none());
        assert!(settings.get("alertThresholds").is_none());
        assert_eq!(settings["alertsEnabled"], json!(true));

        // 二次迁移幂等：实例不重复、数据不丢
        migrate_to_instances(&mut vault, &db).unwrap();
        assert_eq!(db.list_instances().unwrap().len(), 2);
        assert_eq!(vault.credentials().unwrap()["deepseek"]["apiKey"], json!("sk-1"));
    }

    /// 0.9.x 的 `workbuddyCookie`（Copy as cURL 原文）刻意不迁移：拆一段导出文本换不来
    /// 一次重填的价值（ADR-0029 四次修订）——旧扁平键不映射到任何槽，实例也不替它建
    #[test]
    fn legacy_workbuddy_curl_credential_is_deliberately_not_migrated() {
        let curl =
            "curl 'https://www.workbuddy.cn/x' -H 'Cookie: session=abc|1790|xyz; session_2=def'";
        let (mut vault, db) =
            legacy_unlocked_vault("wb-legacy", json!({ "workbuddyCookie": curl }));
        migrate_to_instances(&mut vault, &db).unwrap();

        assert!(db.get_instance("workbuddy").unwrap().is_none());
        let credentials = vault.credentials().unwrap();
        assert!(credentials.get("workbuddy").is_none());
        assert!(
            credentials.to_string().find("session_2=def").is_none(),
            "旧原文不应被搬进任何槽"
        );
    }

    #[test]
    fn migration_skips_locked_vault_and_empty_credentials() {
        // 空凭据：不建任何实例，但 settings 剥除 + 内层升 v2
        let (mut vault, db) = legacy_unlocked_vault("empty", json!({}));
        db.save_settings(&json!({
            "providers": { "deepseek": true },
            "alertThresholds": { "deepseekBalanceBelowCny": 50 }
        }))
        .unwrap();
        migrate_to_instances(&mut vault, &db).unwrap();
        assert!(db.list_instances().unwrap().is_empty());
        assert_eq!(vault.inner_version(), Some(2));
        assert!(db.get_settings().unwrap().get("providers").is_none());

        // 未解锁（主密码迁移未完成）：整体跳过，等待 vault_migrate 后补跑
        let dir = temp_path("locked");
        let path = dir.join("vault.json");
        let salt = random_bytes(16);
        let nonce = random_bytes(12);
        let key = derive_legacy_key("pw", &salt).unwrap();
        let payload = json!({ "version": 1, "credentials": { "glmCodingPlanKey": "plan" } });
        let ciphertext =
            encrypt(&key, &nonce, &serde_json::to_vec(&payload).unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(&json!({
                "version": 1,
                "kdf": "argon2id",
                "salt": BASE64.encode(&salt),
                "nonce": BASE64.encode(&nonce),
                "ciphertext": BASE64.encode(&ciphertext),
            }))
            .unwrap(),
        )
        .unwrap();
        let mut vault = Vault::new(path, Box::new(MemoryKeyStore::default()));
        vault.open().unwrap();
        assert!(!vault.is_unlocked());
        let db = Db::open(&dir.join("test.db")).unwrap();
        migrate_to_instances(&mut vault, &db).unwrap();
        assert!(db.list_instances().unwrap().is_empty());

        // 完成主密码迁移后补跑，实例出现
        vault.migrate("pw").unwrap();
        migrate_to_instances(&mut vault, &db).unwrap();
        let instances = db.list_instances().unwrap();
        assert_eq!(instances.len(), 1);
        assert_eq!(instances[0].id, "glm");
    }

    #[test]
    fn fresh_vault_is_already_v2_and_needs_no_migration() {
        let (mut vault, db) = open_vault_and_db("fresh");
        migrate_to_instances(&mut vault, &db).unwrap();
        assert!(db.list_instances().unwrap().is_empty());
        assert_eq!(vault.inner_version(), Some(2));
    }

    #[test]
    fn instance_crud_round_trip() {
        let (_vault, db) = open_vault_and_db("crud");
        let now = chrono_utc_now();
        db.insert_instance(
            &StoredInstance {
                id: "deepseek".into(),
                provider_id: "deepseek".into(),
                note: "主账号".into(),
                sort_order: 0,
                pinned: false,
                auto_refresh: true,
                threshold: Some(50.0),
                balance_threshold: Some(5.0),
                site: "china".into(),
                created_at: now,
            },
            false,
        )
        .unwrap();
        let next_order = db.next_sort_order().unwrap();
        db.insert_instance(
            &StoredInstance {
                id: "uuid-2".into(),
                provider_id: "deepseek".into(),
                note: String::new(),
                sort_order: next_order,
                pinned: true,
                auto_refresh: false,
                threshold: None,
                balance_threshold: None,
                site: "china".into(),
                created_at: now,
            },
            false,
        )
        .unwrap();

        let instances = db.list_instances().unwrap();
        assert_eq!(instances.len(), 2);
        assert_eq!(instances[0].id, "uuid-2", "置顶实例排最前");
        assert!(instances[0].pinned);

        // patch：note 改、threshold 清空、balance_threshold 设置、pinned 不动
        db.update_instance(
            "deepseek",
            Some("改名"),
            Some(false),
            None,
            Some(None),
            Some(Some(3.5)),
            None,
        )
        .unwrap();
        let updated = db.get_instance("deepseek").unwrap().unwrap();
        assert_eq!(updated.note, "改名");
        assert!(!updated.auto_refresh);
        assert!(updated.threshold.is_none());
        assert_eq!(updated.balance_threshold, Some(3.5));

        // balance_threshold 清除（三层语义的 Some(None)）
        db.update_instance("deepseek", None, None, None, None, Some(None), None)
            .unwrap();
        let cleared = db.get_instance("deepseek").unwrap().unwrap();
        assert!(cleared.balance_threshold.is_none());

        // reorder 后顺序翻转
        db.reorder_instances(&["deepseek".into(), "uuid-2".into()])
            .unwrap();
        let reordered = db.list_instances().unwrap();
        assert_eq!(reordered[0].id, "uuid-2", "pinned 仍优先于 sort_order");

        // 不存在的 id
        assert!(db.update_instance("missing", None, None, None, None, None, None).is_err());
        assert!(db.reorder_instances(&["missing".into()]).is_err());
    }

    /// 存量库的 provider_instances 没有 balance_threshold 列：打开时补列，数据保留、可立即写入
    #[test]
    fn legacy_instance_table_gains_balance_threshold_column() {
        let dir = temp_path("balance-col");
        let db_path = dir.join("legacy.db");
        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE provider_instances (
                    id           TEXT PRIMARY KEY,
                    provider_id  TEXT NOT NULL,
                    note         TEXT NOT NULL DEFAULT '',
                    sort_order   INTEGER NOT NULL DEFAULT 0,
                    pinned       INTEGER NOT NULL DEFAULT 0,
                    auto_refresh INTEGER NOT NULL DEFAULT 1,
                    threshold    REAL,
                    created_at   INTEGER NOT NULL
                );
                INSERT INTO provider_instances(id, provider_id, threshold, created_at)
                    VALUES('glm', 'glm', 80.0, 0);
                "#,
            )
            .unwrap();
        }
        let db = Db::open(&db_path).unwrap();
        let instance = db.get_instance("glm").unwrap().unwrap();
        assert_eq!(instance.threshold, Some(80.0));
        assert!(instance.balance_threshold.is_none());

        db.update_instance("glm", None, None, None, None, Some(Some(5.0)), None)
            .unwrap();
        assert_eq!(
            db.get_instance("glm").unwrap().unwrap().balance_threshold,
            Some(5.0)
        );
    }

    /// 存量库的 provider_instances 没有 site 列（ADR-0030 之前）：打开时补列，缺省中国站
    #[test]
    fn legacy_instance_table_gains_site_column() {
        let dir = temp_path("site-col");
        let db_path = dir.join("legacy.db");
        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE provider_instances (
                    id           TEXT PRIMARY KEY,
                    provider_id  TEXT NOT NULL,
                    note         TEXT NOT NULL DEFAULT '',
                    sort_order   INTEGER NOT NULL DEFAULT 0,
                    pinned       INTEGER NOT NULL DEFAULT 0,
                    auto_refresh INTEGER NOT NULL DEFAULT 1,
                    threshold    REAL,
                    created_at   INTEGER NOT NULL
                );
                INSERT INTO provider_instances(id, provider_id, created_at)
                    VALUES('qoder-legacy', 'qoder', 0);
                "#,
            )
            .unwrap();
        }
        let db = Db::open(&db_path).unwrap();
        let instance = db.get_instance("qoder-legacy").unwrap().unwrap();
        assert_eq!(instance.site, "china", "存量行缺省中国站");

        db.update_instance(
            "qoder-legacy",
            None,
            None,
            None,
            None,
            None,
            Some("international"),
        )
        .unwrap();
        assert_eq!(
            db.get_instance("qoder-legacy").unwrap().unwrap().site,
            "international"
        );
    }

    #[test]
    fn site_validation_and_qoder_credential_label() {
        assert!(validate_site("china").is_ok());
        assert!(validate_site("international").is_ok());
        assert!(validate_site("us").is_err());
        assert!(validate_site("").is_err());

        assert_eq!(
            credential_label("qoder", "cookie"),
            Some("Qoder 会话 Cookie 值")
        );
        assert!(credential_label("qoder", "planKey").is_none());
    }

    #[test]
    fn delete_instance_cascades_snapshots_and_notifications() {
        let (_vault, db) = open_vault_and_db("cascade");
        let now = chrono_utc_now();
        for (id, kind) in [("deepseek", "deepseek"), ("glm", "glm")] {
            db.insert_instance(
                &StoredInstance {
                    id: id.into(),
                    provider_id: kind.into(),
                    note: String::new(),
                    sort_order: 0,
                    pinned: false,
                    auto_refresh: true,
                    threshold: None,
                    balance_threshold: None,
                    site: "china".into(),
                    created_at: now,
                },
                false,
            )
            .unwrap();
        }
        let snapshot = json!({ "updatedAt": now });
        db.save_snapshot("deepseek", &snapshot).unwrap();
        db.save_snapshot("glm", &snapshot).unwrap();
        db.add_notification("deepseek", None, 0, "标题", "正文", None).unwrap();
        db.add_notification("glm", None, 0, "标题", "正文", Some(r#"{"rule":"余额告警"}"#)).unwrap();

        db.delete_instance("deepseek").unwrap();

        assert!(db.get_instance("deepseek").unwrap().is_none());
        let snapshots = db.get_latest_snapshots().unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].instance_id, "glm");
        let notifications = db.list_notifications(10).unwrap();
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].instance_id, "glm");
    }

    #[test]
    fn legacy_provider_id_columns_are_renamed() {
        let dir = temp_path("rename");
        let db_path = dir.join("legacy.db");
        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            let now = chrono_utc_now();
            conn.execute_batch(&format!(
                r#"
                CREATE TABLE snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    provider_id TEXT NOT NULL,
                    captured_at INTEGER NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE INDEX idx_snapshots_provider_id ON snapshots(provider_id, id DESC);
                CREATE TABLE notifications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at INTEGER NOT NULL,
                    provider_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    body TEXT NOT NULL,
                    read INTEGER NOT NULL DEFAULT 0
                );
                INSERT INTO snapshots(provider_id, captured_at, payload)
                    VALUES('deepseek', {now}, '{{"updatedAt":{now}}}');
                INSERT INTO notifications(created_at, provider_id, title, body, read)
                    VALUES({now}, 'deepseek', 't', 'b', 0);
                "#,
            ))
            .unwrap();
        }
        let db = Db::open(&db_path).unwrap();
        let snapshots = db.get_latest_snapshots().unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].instance_id, "deepseek");
        assert_eq!(
            db.list_notifications(10).unwrap()[0].instance_id,
            "deepseek"
        );
        // 重复打开幂等
        drop(db);
        let db = Db::open(&db_path).unwrap();
        assert_eq!(db.get_latest_snapshots().unwrap().len(), 1);
    }

    #[test]
    fn slot_resolution_and_labels() {
        let creds = json!({ "apiKey": "sk-1", "userToken": "tok-1" });
        assert_eq!(instance_credential(&creds, "apiKey"), Some("sk-1"));
        assert_eq!(instance_credential(&creds, "userToken"), Some("tok-1"));
        assert_eq!(instance_credential(&creds, "missing"), None);
        assert_eq!(instance_credential(&json!({ "apiKey": "" }), "apiKey"), None);

        assert_eq!(default_bearer_slot("deepseek"), Some("apiKey"));
        assert_eq!(default_bearer_slot("glm"), Some("planKey"));
        assert_eq!(
            credential_label("deepseek", "userToken"),
            Some("DeepSeek UserToken")
        );
        assert!(credential_label("deepseek", "planKey").is_none());
    }

    #[test]
    fn every_provider_kind_registers_hosts() {
        for (kind, _slots) in PROVIDER_KINDS {
            assert!(
                allowed_hosts(kind).is_some(),
                "{kind} 在 PROVIDER_KINDS 里有，但 ALLOWED_HOSTS 没登记目标域名"
            );
        }
    }

    #[test]
    fn request_url_limited_to_own_kind_hosts() {
        let glm_quota = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
        let qoder_intl = "https://qoder.com/api/v2/me/usages/big_model_credits";
        let workbuddy_resource = "https://www.workbuddy.ai/billing/meter/get-user-resource";
        assert!(validate_request_url("glm", glm_quota).is_ok());
        assert!(validate_request_url("qoder", qoder_intl).is_ok());
        // 跨种类：凭据离开所属供应商即算泄露
        assert!(validate_request_url("workbuddy", glm_quota).is_err());
        assert!(validate_request_url("qoder", workbuddy_resource).is_err());
        assert!(validate_request_url("glm", workbuddy_resource).is_err());
    }

    #[test]
    fn request_url_rejects_lookalike_and_downgrade_targets() {
        // 以允许域结尾的第三方主机名（后缀匹配会误放行，所以只做精确比对）
        assert!(validate_request_url("workbuddy", "https://www.workbuddy.cn.evil.com/x").is_err());
        // 允许域写进 userinfo，目的地其实是 evil.com
        assert!(validate_request_url("workbuddy", "https://www.workbuddy.cn@evil.com/x").is_err());
        // 非 https、显式端口、无法解析、未登记种类
        assert!(validate_request_url("qoder", "http://qoder.com/api").is_err());
        assert!(validate_request_url("qoder", "https://qoder.com:8443/api").is_err());
        assert!(validate_request_url("qoder", "不是地址").is_err());
        assert!(validate_request_url("skynet", "https://qoder.com/api").is_err());
    }

    #[test]
    fn probe_url_takes_union_of_registered_hosts() {
        let opencode_dashboard = "https://opencode.ai/workspace/wrk_x/go";
        let deepseek_balance = "https://api.deepseek.com/user/balance";
        let glm_balance = "https://www.bigmodel.cn/api/biz/account/query-customer-account-report";
        assert!(validate_probe_url(opencode_dashboard).is_ok());
        assert!(validate_probe_url(deepseek_balance).is_ok());
        assert!(validate_probe_url(glm_balance).is_ok());
        // 探测同样不允许离开登记过的 9 个 host
        assert!(validate_probe_url("https://github.com/XSIJIE975/ai-usage-tracker").is_err());
        assert!(validate_probe_url("http://qoder.com/api").is_err());
    }

    #[test]
    fn workbuddy_session_requires_all_three_slots() {
        let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/153.0.0.0 Edg/153.0.0.0";
        let full = json!({ "session": "s-1", "session2": "s-2", "userAgent": ua });
        let session = workbuddy_session(&full).unwrap();
        assert_eq!(session.cookie_header, "session=s-1; session_2=s-2");
        assert_eq!(session.user_agent, ua);

        // 缺一即点名那一槽，不静默用兜底 UA（ADR-0029 四次修订）
        assert!(
            workbuddy_session(&json!({ "session": "s-1", "userAgent": ua }))
                .unwrap_err()
                .contains("session_2")
        );
        assert!(
            workbuddy_session(&json!({ "session": "s-1", "session2": "s-2" }))
                .unwrap_err()
                .contains("User-Agent")
        );
        // 空串等同未填
        assert!(
            workbuddy_session(&json!({ "session": "", "session2": "s-2", "userAgent": ua }))
                .unwrap_err()
                .contains("session")
        );
        // 把整段 Cookie 头贴进一格（带空格与分号）→ 非法字符，而不是拼出坏头
        assert!(workbuddy_session(
            &json!({ "session": "session=s-1; session_2=s-2", "session2": "s-2", "userAgent": ua })
        )
        .unwrap_err()
        .contains("非法字符"));
    }
}
