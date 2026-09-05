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
        _ => None,
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
        )
        .unwrap();
        let updated = db.get_instance("deepseek").unwrap().unwrap();
        assert_eq!(updated.note, "改名");
        assert!(!updated.auto_refresh);
        assert!(updated.threshold.is_none());
        assert_eq!(updated.balance_threshold, Some(3.5));

        // balance_threshold 清除（三层语义的 Some(None)）
        db.update_instance("deepseek", None, None, None, None, Some(None))
            .unwrap();
        let cleared = db.get_instance("deepseek").unwrap().unwrap();
        assert!(cleared.balance_threshold.is_none());

        // reorder 后顺序翻转
        db.reorder_instances(&["deepseek".into(), "uuid-2".into()])
            .unwrap();
        let reordered = db.list_instances().unwrap();
        assert_eq!(reordered[0].id, "uuid-2", "pinned 仍优先于 sort_order");

        // 不存在的 id
        assert!(db.update_instance("missing", None, None, None, None, None).is_err());
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

        db.update_instance("glm", None, None, None, None, Some(Some(5.0)))
            .unwrap();
        assert_eq!(
            db.get_instance("glm").unwrap().unwrap().balance_threshold,
            Some(5.0)
        );
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
                    created_at: now,
                },
                false,
            )
            .unwrap();
        }
        let snapshot = json!({ "updatedAt": now });
        db.save_snapshot("deepseek", &snapshot).unwrap();
        db.save_snapshot("glm", &snapshot).unwrap();
        db.add_notification("deepseek", "标题", "正文").unwrap();
        db.add_notification("glm", "标题", "正文").unwrap();

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
}
