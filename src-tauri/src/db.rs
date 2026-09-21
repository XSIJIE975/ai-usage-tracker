use std::path::Path;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 快照保留期：30 天，打开数据库时清理更早的历史
const SNAPSHOT_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// 通知保留期与条数上限：30 天 / 200 条，插入时顺带清理
const NOTIFICATION_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const NOTIFICATION_MAX_COUNT: i64 = 200;

#[derive(Serialize)]
pub struct StoredSnapshot {
    pub instance_id: String,
    pub captured_at: i64,
    pub payload: Value,
}

#[derive(Serialize)]
pub struct StoredNotification {
    pub id: i64,
    pub created_at: i64,
    pub instance_id: String,
    pub title: String,
    pub body: String,
    /// 模板参数（ADR-0022）：JSON 对象的文本形式；存量行为 NULL，前端原样显示
    pub params: Option<Value>,
    pub read: bool,
}

/// 一条告警规则的边沿/冷却状态（ADR-0025）：事实源在库，评估窗口重载或应用重启后据此水合。
/// 字段 snake_case 与 StoredNotification 同口径
#[derive(Serialize, Deserialize)]
pub struct StoredAlertState {
    pub rule_key: String,
    pub instance_id: String,
    pub triggered: bool,
    pub last_notified_at: i64,
}

/// 重置卡到账检测的已见集合：每实例一行，record_ids 是最近一轮在线的可用卡 recordId 全集
/// （历史已用/过期 id 不保留——差集方向是「本轮可用 − 已见」，旧 id 留着无意义）。
/// seeded 区分「播种过但 0 张」（record_ids 为空）与「从未播种」（无行）：后者首次成功
/// 刷新时把存量卡整体播种、不发通知，避免功能上线/重建实例首刷误报。字段 snake_case
/// 与 StoredAlertState 同口径
#[derive(Serialize, Deserialize)]
pub struct StoredSeenResetCards {
    pub instance_id: String,
    pub record_ids: Vec<i64>,
    pub seeded: bool,
}

/// WorkBuddy 签到通知的判重事实源：每实例一行，notified_date 是最近一次发出
/// 「签到成功」通知的日期（CST YYYY-MM-DD）。快照上的签到字段是瞬时冗余、会随
/// 落库快照重放（重启后 reevaluate 重读同一份），通知判重的权威在这里，
/// 重启后同一天的旧快照重放不再重复通知。字段 snake_case 与 StoredAlertState 同口径
#[derive(Serialize, Deserialize)]
pub struct StoredWorkbuddyCheckin {
    pub instance_id: String,
    pub notified_date: String,
}

/// 旅行领奖通知判重行：claimed_key 是最近一次通知的行程标识（depart_at）。
/// 按行程而非日期——一天可有多趟旅行，各趟各判各的；语义同 StoredWorkbuddyCheckin
#[derive(Serialize, Deserialize)]
pub struct StoredWorkbuddyTravelClaim {
    pub instance_id: String,
    pub claimed_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredInstance {
    pub id: String,
    pub provider_id: String,
    pub note: String,
    pub sort_order: i64,
    pub pinned: bool,
    pub auto_refresh: bool,
    pub threshold: Option<f64>,
    /// 余额告警阈值（元，仅 glm 使用）；None=不告警
    pub balance_threshold: Option<f64>,
    pub created_at: i64,
}

pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|error| error.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| error.to_string())?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS provider_instances (
                id                TEXT PRIMARY KEY,
                provider_id       TEXT NOT NULL,
                note              TEXT NOT NULL DEFAULT '',
                sort_order        INTEGER NOT NULL DEFAULT 0,
                pinned            INTEGER NOT NULL DEFAULT 0,
                auto_refresh      INTEGER NOT NULL DEFAULT 1,
                threshold         REAL,
                balance_threshold REAL,
                created_at        INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instance_id TEXT NOT NULL,
                captured_at INTEGER NOT NULL,
                payload TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at INTEGER NOT NULL,
                instance_id TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                params TEXT,
                read INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS alert_states (
                rule_key TEXT PRIMARY KEY,
                instance_id TEXT NOT NULL,
                triggered INTEGER NOT NULL DEFAULT 0,
                last_notified_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS seen_reset_cards (
                instance_id TEXT PRIMARY KEY,
                record_ids TEXT NOT NULL,
                seeded INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS workbuddy_checkins (
                instance_id TEXT PRIMARY KEY,
                notified_date TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS workbuddy_travel_claims (
                instance_id TEXT PRIMARY KEY,
                claimed_key TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            "#,
        )
        .map_err(|error| error.to_string())?;
        let db = Self { conn };
        db.rename_legacy_provider_columns()?;
        db.ensure_instance_balance_threshold_column()?;
        db.ensure_notification_params_column()?;
        // 索引依赖列名，必须在改名之后建
        db.conn
            .execute_batch(
                r#"
                DROP INDEX IF EXISTS idx_snapshots_provider_id;
                CREATE INDEX IF NOT EXISTS idx_snapshots_instance_id
                    ON snapshots(instance_id, id DESC);
                CREATE INDEX IF NOT EXISTS idx_notifications_created
                    ON notifications(created_at DESC);
                "#,
            )
            .map_err(|error| error.to_string())?;
        // 快照只服务于按实例的差分与告警，超过保留期的旧数据没有价值，打开时顺带清理
        let cutoff = chrono_utc_now() - SNAPSHOT_RETENTION_MS;
        if let Err(error) =
            db.conn
                .execute("DELETE FROM snapshots WHERE captured_at < ?1", [cutoff])
        {
            eprintln!("清理历史快照失败：{error}");
        }

        Ok(db)
    }

    /// 旧库的 snapshots/notifications 以 provider_id 为列（供应商即实例的时代遗留）；
    /// SQLite 3.25+ 的 RENAME COLUMN 只改名不改行数据，历史快照与通知零改写继承
    fn rename_legacy_provider_columns(&self) -> Result<(), String> {
        for table in ["snapshots", "notifications"] {
            let mut statement = self
                .conn
                .prepare(&format!("PRAGMA table_info({table})"))
                .map_err(|error| error.to_string())?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<String>, _>>()
                .map_err(|error| error.to_string())?;
            if columns.iter().any(|c| c == "provider_id") {
                self.conn
                    .execute_batch(&format!(
                        "ALTER TABLE {table} RENAME COLUMN provider_id TO instance_id;"
                    ))
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    /// 余额告警阈值列（ADR-0013）晚于建表语句加入：存量库用 ALTER TABLE 补列，
    /// 新库建表已含该列，此函数为幂等空操作
    fn ensure_instance_balance_threshold_column(&self) -> Result<(), String> {
        let mut statement = self
            .conn
            .prepare("PRAGMA table_info(provider_instances)")
            .map_err(|error| error.to_string())?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|error| error.to_string())?;
        if !columns.iter().any(|column| column == "balance_threshold") {
            self.conn
                .execute_batch("ALTER TABLE provider_instances ADD COLUMN balance_threshold REAL;")
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    /// 通知模板参数列（ADR-0022）晚于建表语句加入：存量库用 ALTER TABLE 补列，
    /// 新库建表已含该列，此函数为幂等空操作。存量通知行 params 为 NULL，前端原样显示。
    fn ensure_notification_params_column(&self) -> Result<(), String> {
        let mut statement = self
            .conn
            .prepare("PRAGMA table_info(notifications)")
            .map_err(|error| error.to_string())?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|error| error.to_string())?;
        if !columns.iter().any(|column| column == "params") {
            self.conn
                .execute_batch("ALTER TABLE notifications ADD COLUMN params TEXT;")
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn get_settings(&self) -> Result<Value, String> {
        let default = serde_json::json!({
            "refreshEnabled": true,
            "refreshIntervalMinutes": 5,
            "alertsEnabled": true,
            // 告警冷却（ADR-0025）：后端判重与前端评估共用同一默认，存量库缺键时由此补齐
            "alertCooldownHours": 6,
            // 开发实例默认 Ctrl+Shift+U（ADR-0018）：与安装版的 Alt+U 错开，
            // 两实例并存时全局快捷键不再抢占同一注册位
            "quickPanelShortcut": if cfg!(debug_assertions) { "Control+Shift+KeyU" } else { "Alt+KeyU" },
            "quickAutoHide": true,
            "resetTimeDisplay": "relative",
            "interfaceLanguage": "auto",
            "autoStart": false,
            "silentStart": false
        });
        let row = self.conn.query_row(
            "SELECT value FROM settings WHERE key = 'app_settings'",
            [],
            |row| row.get::<_, String>(0),
        );
        match row {
            Ok(value) => {
                let mut stored: Value = serde_json::from_str(&value).map_err(|error| error.to_string())?;
                // 逐键补默认值：旧版本写入的行缺新版本引入的键（如 quickPanelShortcut），
                // 不补会导致启动注册等后端消费方取不到键而静默失效（前端 UI 因自身合并默认值而看不到差异）
                if let (Some(stored_obj), Some(default_obj)) = (stored.as_object_mut(), default.as_object()) {
                    for (key, value) in default_obj {
                        stored_obj.entry(key.clone()).or_insert(value.clone());
                    }
                }
                Ok(stored)
            }
            // 无行 = 首次启动，全套默认值属正常路径
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(default),
            // 读失败必须可见（ADR-0024）：静默回默认值会让用户下一次保存把真实设置整体覆盖
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn save_settings(&self, settings: &Value) -> Result<(), String> {
        let value = serde_json::to_string(settings).map_err(|error| error.to_string())?;
        self.conn
            .execute(
                r#"
                INSERT INTO settings(key, value) VALUES('app_settings', ?1)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                "#,
                [&value],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    // ─── 供应商实例 ───

    pub fn list_instances(&self) -> Result<Vec<StoredInstance>, String> {
        let mut statement = self
            .conn
            .prepare(
                r#"
                SELECT id, provider_id, note, sort_order, pinned, auto_refresh, threshold, balance_threshold, created_at
                FROM provider_instances
                ORDER BY pinned DESC, sort_order ASC, created_at ASC
                "#,
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(StoredInstance {
                    id: row.get(0)?,
                    provider_id: row.get(1)?,
                    note: row.get(2)?,
                    sort_order: row.get(3)?,
                    pinned: row.get::<_, i64>(4)? != 0,
                    auto_refresh: row.get::<_, i64>(5)? != 0,
                    threshold: row.get(6)?,
                    balance_threshold: row.get(7)?,
                    created_at: row.get(8)?,
                })
            })
            .map_err(|error| error.to_string())?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|error| error.to_string())?);
        }
        Ok(result)
    }

    pub fn get_instance(&self, id: &str) -> Result<Option<StoredInstance>, String> {
        let mut statement = self
            .conn
            .prepare(
                r#"
                SELECT id, provider_id, note, sort_order, pinned, auto_refresh, threshold, balance_threshold, created_at
                FROM provider_instances WHERE id = ?1
                "#,
            )
            .map_err(|error| error.to_string())?;
        let row = statement
            .query_row([id], |row| {
                Ok(StoredInstance {
                    id: row.get(0)?,
                    provider_id: row.get(1)?,
                    note: row.get(2)?,
                    sort_order: row.get(3)?,
                    pinned: row.get::<_, i64>(4)? != 0,
                    auto_refresh: row.get::<_, i64>(5)? != 0,
                    threshold: row.get(6)?,
                    balance_threshold: row.get(7)?,
                    created_at: row.get(8)?,
                })
            })
            .map(|instance| Some(instance))
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
            .map_err(|error| error.to_string())?;
        Ok(row)
    }

    pub fn insert_instance(
        &self,
        instance: &StoredInstance,
        or_ignore: bool,
    ) -> Result<(), String> {
        let conflict = if or_ignore { "OR IGNORE" } else { "" };
        self.conn
            .execute(
                &format!(
                    r#"
                    INSERT {conflict} INTO provider_instances
                        (id, provider_id, note, sort_order, pinned, auto_refresh, threshold, balance_threshold, created_at)
                    VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                    "#
                ),
                rusqlite::params![
                    instance.id,
                    instance.provider_id,
                    instance.note,
                    instance.sort_order,
                    instance.pinned as i64,
                    instance.auto_refresh as i64,
                    instance.threshold,
                    instance.balance_threshold,
                    instance.created_at,
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// 追加到网格末尾用的下一个 sort_order
    pub fn next_sort_order(&self) -> Result<i64, String> {
        self.conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM provider_instances",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
    }

    pub fn update_instance(
        &self,
        id: &str,
        note: Option<&str>,
        auto_refresh: Option<bool>,
        pinned: Option<bool>,
        threshold: Option<Option<f64>>,
        balance_threshold: Option<Option<f64>>,
    ) -> Result<(), String> {
        let current = self
            .get_instance(id)?
            .ok_or_else(|| "实例不存在".to_string())?;
        // threshold 的三层语义：None=不改、Some(None)=清除、Some(Some(v))=设置
        self.conn
            .execute(
                r#"
                UPDATE provider_instances
                SET note = ?2, auto_refresh = ?3, pinned = ?4, threshold = ?5, balance_threshold = ?6
                WHERE id = ?1
                "#,
                rusqlite::params![
                    id,
                    note.unwrap_or(&current.note),
                    auto_refresh.unwrap_or(current.auto_refresh) as i64,
                    pinned.unwrap_or(current.pinned) as i64,
                    threshold.unwrap_or(current.threshold),
                    balance_threshold.unwrap_or(current.balance_threshold),
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn reorder_instances(&self, ordered_ids: &[String]) -> Result<(), String> {
        // 事务包裹（ADR-0024）：逐条 UPDATE 中途失败（含清单校验不过）整体回滚，
        // 不给数据库留下半新半旧的撕裂排序
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        let mut count = 0;
        for (index, id) in ordered_ids.iter().enumerate() {
            count += tx
                .execute(
                    "UPDATE provider_instances SET sort_order = ?2 WHERE id = ?1",
                    rusqlite::params![id, index as i64],
                )
                .map_err(|error| error.to_string())?;
        }
        if count != ordered_ids.len() {
            return Err("排序清单与现有实例不一致".to_string());
        }
        tx.commit().map_err(|error| error.to_string())?;
        Ok(())
    }

    /// 删除实例及其全部从属数据（快照、通知）；凭据由调用方在 vault 侧清理
    pub fn delete_instance(&self, id: &str) -> Result<(), String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM provider_instances WHERE id = ?1", [id])
            .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM snapshots WHERE instance_id = ?1", [id])
            .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM notifications WHERE instance_id = ?1", [id])
            .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM alert_states WHERE instance_id = ?1", [id])
            .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM seen_reset_cards WHERE instance_id = ?1", [id])
            .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM workbuddy_checkins WHERE instance_id = ?1", [id])
            .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM workbuddy_travel_claims WHERE instance_id = ?1", [id])
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(())
    }

    // ─── 快照 ───

    pub fn save_snapshot(&self, instance_id: &str, payload: &Value) -> Result<(), String> {
        let captured_at = payload
            .get("updatedAt")
            .and_then(Value::as_i64)
            .unwrap_or_else(|| chrono_utc_now());
        let body = serde_json::to_string(payload).map_err(|error| error.to_string())?;
        self.conn
            .execute(
                "INSERT INTO snapshots(instance_id, captured_at, payload) VALUES(?1, ?2, ?3)",
                rusqlite::params![instance_id, captured_at, body],
            )
            .map_err(|error| error.to_string())?;
        // 保留策略随写入顺带执行：之前只在打开数据库时清一次，托盘常驻数月不重启
        // 会让 30 天外的旧行持续累积（ADR-0024）。表有保留期上界，扫描成本可忽略。
        let cutoff = chrono_utc_now() - SNAPSHOT_RETENTION_MS;
        if let Err(error) = self
            .conn
            .execute("DELETE FROM snapshots WHERE captured_at < ?1", [cutoff])
        {
            eprintln!("清理历史快照失败：{error}");
        }
        Ok(())
    }

    pub fn get_latest_snapshots(&self) -> Result<Vec<StoredSnapshot>, String> {
        let mut statement = self
            .conn
            .prepare(
                r#"
                SELECT s.instance_id, s.captured_at, s.payload
                FROM snapshots s
                JOIN (
                    SELECT instance_id, MAX(id) AS max_id
                    FROM snapshots
                    GROUP BY instance_id
                ) latest ON latest.max_id = s.id
                ORDER BY s.instance_id
                "#,
            )
            .map_err(|error| error.to_string())?;

        let rows = statement
            .query_map([], |row| {
                Ok(StoredSnapshot {
                    instance_id: row.get(0)?,
                    captured_at: row.get(1)?,
                    payload: serde_json::from_str(&row.get::<_, String>(2)?)
                        .unwrap_or_else(|_| Value::Null),
                })
            })
            .map_err(|error| error.to_string())?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|error| error.to_string())?);
        }
        Ok(result)
    }

    // ─── 通知 ───

    /// 写入一条告警通知，并按保留策略（30 天 / 200 条）清理旧数据。
    /// params 是模板参数的 JSON 文本（ADR-0022）；传 None 即存量兼容的成品文案。
    /// 告警通知入口（ADR-0025）：携带 rule_key 时后端先做冷却判重——冷却期内返回 Ok(None)，
    /// 前端据此跳过系统通知；判定通过才落库，并同步推进该规则的冷却时间戳。
    /// 判重是权威的：即使前端协调器状态丢失（F5/重启），这里也不会放行重复通知。
    /// cooldown_ms <= 0 表示冷却关闭，只落库不判重。
    pub fn add_notification(
        &self,
        instance_id: &str,
        rule_key: Option<&str>,
        cooldown_ms: i64,
        title: &str,
        body: &str,
        params: Option<&str>,
    ) -> Result<Option<StoredNotification>, String> {
        let created_at = chrono_utc_now();
        if let Some(rule_key) = rule_key {
            if cooldown_ms > 0 {
                let last_notified_at: Option<i64> = self
                    .conn
                    .query_row(
                        "SELECT last_notified_at FROM alert_states WHERE rule_key = ?1",
                        [rule_key],
                        |row| row.get(0),
                    )
                    .map(Some)
                    .or_else(|error| match error {
                        rusqlite::Error::QueryReturnedNoRows => Ok(None),
                        other => Err(other),
                    })
                    .map_err(|error| error.to_string())?;
                if let Some(last) = last_notified_at {
                    if created_at - last < cooldown_ms {
                        return Ok(None);
                    }
                }
            }
        }
        self.conn
            .execute(
                "INSERT INTO notifications(created_at, instance_id, title, body, params) VALUES(?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![created_at, instance_id, title, body, params],
            )
            .map_err(|error| error.to_string())?;
        let id = self.conn.last_insert_rowid();

        // 判定通过即推进冷却：边沿态置 true、时间戳定格为本次落库时刻（墙钟语义的锚点）
        if let Some(rule_key) = rule_key {
            self.conn
                .execute(
                    r#"
                    INSERT INTO alert_states(rule_key, instance_id, triggered, last_notified_at)
                    VALUES(?1, ?2, 1, ?3)
                    ON CONFLICT(rule_key) DO UPDATE SET
                        instance_id = excluded.instance_id,
                        triggered = 1,
                        last_notified_at = excluded.last_notified_at
                    "#,
                    rusqlite::params![rule_key, instance_id, created_at],
                )
                .map_err(|error| error.to_string())?;
        }

        let retention_cutoff = created_at - NOTIFICATION_RETENTION_MS;
        if let Err(error) = self.conn.execute(
            "DELETE FROM notifications WHERE created_at < ?1",
            [retention_cutoff],
        ) {
            eprintln!("清理过期通知失败：{error}");
        }
        if let Err(error) = self.conn.execute(
            r#"
            DELETE FROM notifications
            WHERE id NOT IN (
                SELECT id FROM notifications
                ORDER BY created_at DESC, id DESC
                LIMIT ?1
            )
            "#,
            [NOTIFICATION_MAX_COUNT],
        ) {
            eprintln!("裁剪通知数量失败：{error}");
        }

        Ok(Some(StoredNotification {
            id,
            created_at,
            instance_id: instance_id.to_string(),
            title: title.to_string(),
            body: body.to_string(),
            params: params.and_then(|text| serde_json::from_str(text).ok()),
            read: false,
        }))
    }

    /// 全量读出告警规则状态（ADR-0025）：评估窗口启动/重载后据此水合边沿与冷却
    pub fn list_alert_states(&self) -> Result<Vec<StoredAlertState>, String> {
        let mut statement = self
            .conn
            .prepare("SELECT rule_key, instance_id, triggered, last_notified_at FROM alert_states")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(StoredAlertState {
                    rule_key: row.get(0)?,
                    instance_id: row.get(1)?,
                    triggered: row.get::<_, i64>(2)? != 0,
                    last_notified_at: row.get(3)?,
                })
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(rows)
    }

    /// 回写评估窗口产生的状态变化（边沿解除、本地判定的新触发）：
    /// INSERT OR REPLACE 幂等，重复回写同值无副作用
    pub fn save_alert_states(&self, states: &[StoredAlertState]) -> Result<(), String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        for state in states {
            tx.execute(
                r#"
                INSERT INTO alert_states(rule_key, instance_id, triggered, last_notified_at)
                VALUES(?1, ?2, ?3, ?4)
                ON CONFLICT(rule_key) DO UPDATE SET
                    instance_id = excluded.instance_id,
                    triggered = excluded.triggered,
                    last_notified_at = excluded.last_notified_at
                "#,
                rusqlite::params![
                    state.rule_key,
                    state.instance_id,
                    state.triggered as i64,
                    state.last_notified_at
                ],
            )
            .map_err(|error| error.to_string())?;
        }
        tx.commit().map_err(|error| error.to_string())?;
        Ok(())
    }

    /// 读某实例的重置卡已见集合；None = 从未播种（与「播种过但 0 张」是两种状态）
    pub fn get_seen_reset_cards(&self, instance_id: &str) -> Result<Option<StoredSeenResetCards>, String> {
        let row = self.conn.query_row(
            "SELECT record_ids, seeded FROM seen_reset_cards WHERE instance_id = ?1",
            [instance_id],
            |row| {
                let ids_text: String = row.get(0)?;
                Ok((
                    serde_json::from_str::<Vec<i64>>(&ids_text).unwrap_or_default(),
                    row.get::<_, i64>(1)? != 0,
                ))
            },
        );
        match row {
            Ok((record_ids, seeded)) => Ok(Some(StoredSeenResetCards {
                instance_id: instance_id.to_string(),
                record_ids,
                seeded,
            })),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    /// 回写某实例的重置卡已见集合（UPSERT 幂等）：前端检测器的内存投影是判定者，
    /// 这里只是重启恢复用的事实源（与 alert_states 的回写分工同构）
    pub fn save_seen_reset_cards(&self, seen: &StoredSeenResetCards) -> Result<(), String> {
        let ids_text = serde_json::to_string(&seen.record_ids).map_err(|error| error.to_string())?;
        self.conn
            .execute(
                r#"
                INSERT INTO seen_reset_cards(instance_id, record_ids, seeded, updated_at)
                VALUES(?1, ?2, ?3, ?4)
                ON CONFLICT(instance_id) DO UPDATE SET
                    record_ids = excluded.record_ids,
                    seeded = excluded.seeded,
                    updated_at = excluded.updated_at
                "#,
                rusqlite::params![seen.instance_id, ids_text, seen.seeded as i64, chrono_utc_now()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// 读某实例的签到通知判重日期；None = 从未通知过
    pub fn get_workbuddy_checkin(&self, instance_id: &str) -> Result<Option<StoredWorkbuddyCheckin>, String> {
        let row = self.conn.query_row(
            "SELECT notified_date FROM workbuddy_checkins WHERE instance_id = ?1",
            [instance_id],
            |row| row.get::<_, String>(0),
        );
        match row {
            Ok(notified_date) => Ok(Some(StoredWorkbuddyCheckin {
                instance_id: instance_id.to_string(),
                notified_date,
            })),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    /// 回写某实例的签到通知判重日期（UPSERT 幂等）：前端检测器的内存投影是判定者，
    /// 这里只是重启恢复用的事实源——落库快照重放同一天的签到字段不再重复通知
    pub fn save_workbuddy_checkin(&self, checkin: &StoredWorkbuddyCheckin) -> Result<(), String> {
        self.conn
            .execute(
                r#"
                INSERT INTO workbuddy_checkins(instance_id, notified_date, updated_at)
                VALUES(?1, ?2, ?3)
                ON CONFLICT(instance_id) DO UPDATE SET
                    notified_date = excluded.notified_date,
                    updated_at = excluded.updated_at
                "#,
                rusqlite::params![checkin.instance_id, checkin.notified_date, chrono_utc_now()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// 读某实例的旅行领奖判重行程键；None = 从未通知过
    pub fn get_workbuddy_travel_claim(
        &self,
        instance_id: &str,
    ) -> Result<Option<StoredWorkbuddyTravelClaim>, String> {
        let row = self.conn.query_row(
            "SELECT claimed_key FROM workbuddy_travel_claims WHERE instance_id = ?1",
            [instance_id],
            |row| row.get::<_, String>(0),
        );
        match row {
            Ok(claimed_key) => Ok(Some(StoredWorkbuddyTravelClaim {
                instance_id: instance_id.to_string(),
                claimed_key,
            })),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    /// 回写某实例的旅行领奖判重行程键（UPSERT 幂等），语义同 save_workbuddy_checkin：
    /// 落库快照随重启重放 travel 字段，靠这里判重不重复通知
    pub fn save_workbuddy_travel_claim(&self, claim: &StoredWorkbuddyTravelClaim) -> Result<(), String> {
        self.conn
            .execute(
                r#"
                INSERT INTO workbuddy_travel_claims(instance_id, claimed_key, updated_at)
                VALUES(?1, ?2, ?3)
                ON CONFLICT(instance_id) DO UPDATE SET
                    claimed_key = excluded.claimed_key,
                    updated_at = excluded.updated_at
                "#,
                rusqlite::params![claim.instance_id, claim.claimed_key, chrono_utc_now()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn list_notifications(&self, limit: i64) -> Result<Vec<StoredNotification>, String> {
        let mut statement = self
            .conn
            .prepare(
                r#"
                SELECT id, created_at, instance_id, title, body, params, read
                FROM notifications
                ORDER BY created_at DESC, id DESC
                LIMIT ?1
                "#,
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([limit], |row| {
                let params_text: Option<String> = row.get(5)?;
                Ok(StoredNotification {
                    id: row.get(0)?,
                    created_at: row.get(1)?,
                    instance_id: row.get(2)?,
                    title: row.get(3)?,
                    body: row.get(4)?,
                    params: params_text.and_then(|text| serde_json::from_str(&text).ok()),
                    read: row.get::<_, i64>(6)? != 0,
                })
            })
            .map_err(|error| error.to_string())?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|error| error.to_string())?);
        }
        Ok(result)
    }

    pub fn unread_notification_count(&self) -> Result<i64, String> {
        self.conn
            .query_row(
                "SELECT COUNT(*) FROM notifications WHERE read = 0",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
    }

    pub fn mark_all_notifications_read(&self) -> Result<(), String> {
        self.conn
            .execute("UPDATE notifications SET read = 1 WHERE read = 0", [])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn delete_notification(&self, id: i64) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM notifications WHERE id = ?1", [id])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn clear_notifications(&self) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM notifications", [])
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

pub(crate) fn chrono_utc_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::Db;
    use serde_json::{json, Value};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db() -> Db {
        let dir = std::env::temp_dir().join(format!(
            "ai-usage-db-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Db::open(&dir.join("test.db")).unwrap()
    }

    const HOUR_MS: i64 = 3_600_000;

    #[test]
    fn notification_guard_rejects_within_cooldown() {
        let db = temp_db();
        let first = db
            .add_notification("inst-1", Some("inst-1:balance"), 6 * HOUR_MS, "t", "b", None)
            .unwrap();
        assert!(first.is_some(), "首次通知必定放行");
        // 冷却期内（墙钟未到）：后端判重拒绝，不落库、不推进时间戳
        let second = db
            .add_notification("inst-1", Some("inst-1:balance"), 6 * HOUR_MS, "t", "b", None)
            .unwrap();
        assert!(second.is_none(), "冷却期内必须被守卫拒绝");
        assert_eq!(db.list_alert_states().unwrap().len(), 1);
        // cooldown_ms = 0 表示冷却关闭：判重放行
        let third = db
            .add_notification("inst-1", Some("inst-1:balance"), 0, "t", "b", None)
            .unwrap();
        assert!(third.is_some(), "冷却关闭时不判重");
    }

    #[test]
    fn guard_pass_advances_cooldown_anchor() {
        let db = temp_db();
        let first = db
            .add_notification("inst-1", Some("inst-1:quota"), 6 * HOUR_MS, "t", "b", None)
            .unwrap()
            .unwrap();
        let states = db.list_alert_states().unwrap();
        assert_eq!(states.len(), 1);
        let state = &states[0];
        assert_eq!(state.rule_key, "inst-1:quota");
        assert!(state.triggered, "放行即进入告警态");
        assert_eq!(state.last_notified_at, first.created_at, "冷却锚点=落库时刻");
    }

    #[test]
    fn alert_states_roundtrip_preserves_edge_clear() {
        let db = temp_db();
        // 模拟评估窗口回写一条「已解除」状态：水合后不应误报活跃告警
        db.save_alert_states(&[super::StoredAlertState {
            rule_key: "inst-1:balance".into(),
            instance_id: "inst-1".into(),
            triggered: false,
            last_notified_at: 1_000,
        }])
        .unwrap();
        let states = db.list_alert_states().unwrap();
        assert_eq!(states.len(), 1);
        assert!(!states[0].triggered);
        assert_eq!(states[0].last_notified_at, 1_000);
        // 幂等：重复回写同键覆盖不新增
        db.save_alert_states(&[super::StoredAlertState {
            rule_key: "inst-1:balance".into(),
            instance_id: "inst-1".into(),
            triggered: true,
            last_notified_at: 2_000,
        }])
        .unwrap();
        let states = db.list_alert_states().unwrap();
        assert_eq!(states.len(), 1);
        assert!(states[0].triggered);
        assert_eq!(states[0].last_notified_at, 2_000);
    }

    #[test]
    fn delete_instance_cascades_alert_states() {
        let db = temp_db();
        db.add_notification("inst-1", Some("inst-1:balance"), 0, "t", "b", None)
            .unwrap();
        db.add_notification("inst-2", Some("inst-2:quota"), 0, "t", "b", None)
            .unwrap();
        db.delete_instance("inst-1").unwrap();
        let remaining = db.list_alert_states().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].instance_id, "inst-2");
    }

    #[test]
    fn seen_reset_cards_distinguish_unseeded_from_empty() {
        let db = temp_db();
        // 从未播种 = None，这是「首刷播种不通知」的判定依据
        assert!(db.get_seen_reset_cards("inst-1").unwrap().is_none());
        // 播种过但 0 张：无行与空集是两种状态，重启水合后不得混淆
        db.save_seen_reset_cards(&super::StoredSeenResetCards {
            instance_id: "inst-1".into(),
            record_ids: vec![],
            seeded: true,
        })
        .unwrap();
        let seen = db.get_seen_reset_cards("inst-1").unwrap().unwrap();
        assert!(seen.record_ids.is_empty());
        assert!(seen.seeded);
    }

    #[test]
    fn seen_reset_cards_upsert_and_cascade() {
        let db = temp_db();
        db.save_seen_reset_cards(&super::StoredSeenResetCards {
            instance_id: "inst-1".into(),
            record_ids: vec![7, 3],
            seeded: true,
        })
        .unwrap();
        // UPSERT 覆盖旧集合
        db.save_seen_reset_cards(&super::StoredSeenResetCards {
            instance_id: "inst-1".into(),
            record_ids: vec![7, 3, 12],
            seeded: true,
        })
        .unwrap();
        let seen = db.get_seen_reset_cards("inst-1").unwrap().unwrap();
        assert_eq!(seen.record_ids, vec![7, 3, 12]);
        // 删实例级联清理已见集合
        db.save_seen_reset_cards(&super::StoredSeenResetCards {
            instance_id: "inst-2".into(),
            record_ids: vec![9],
            seeded: true,
        })
        .unwrap();
        db.delete_instance("inst-1").unwrap();
        assert!(db.get_seen_reset_cards("inst-1").unwrap().is_none());
        assert_eq!(
            db.get_seen_reset_cards("inst-2").unwrap().unwrap().record_ids,
            vec![9]
        );
    }

    #[test]
    fn workbuddy_checkin_upsert_and_cascade() {
        let db = temp_db();
        // 从未通知 = None：签到检测器据此放行首条通知
        assert!(db.get_workbuddy_checkin("inst-1").unwrap().is_none());
        db.save_workbuddy_checkin(&super::StoredWorkbuddyCheckin {
            instance_id: "inst-1".into(),
            notified_date: "2026-09-20".into(),
        })
        .unwrap();
        // 同一天重复回写（快照重放触发）幂等；跨天覆盖旧日期
        db.save_workbuddy_checkin(&super::StoredWorkbuddyCheckin {
            instance_id: "inst-1".into(),
            notified_date: "2026-09-21".into(),
        })
        .unwrap();
        let checkin = db.get_workbuddy_checkin("inst-1").unwrap().unwrap();
        assert_eq!(checkin.notified_date, "2026-09-21");
        // 删实例级联清理判重行
        db.save_workbuddy_checkin(&super::StoredWorkbuddyCheckin {
            instance_id: "inst-2".into(),
            notified_date: "2026-09-20".into(),
        })
        .unwrap();
        db.delete_instance("inst-1").unwrap();
        assert!(db.get_workbuddy_checkin("inst-1").unwrap().is_none());
        assert_eq!(
            db.get_workbuddy_checkin("inst-2").unwrap().unwrap().notified_date,
            "2026-09-20"
        );
    }

    #[test]
    fn workbuddy_travel_claim_upsert_and_cascade() {
        let db = temp_db();
        // 从未通知 = None：旅行检测器据此放行首条通知
        assert!(db.get_workbuddy_travel_claim("inst-1").unwrap().is_none());
        db.save_workbuddy_travel_claim(&super::StoredWorkbuddyTravelClaim {
            instance_id: "inst-1".into(),
            claimed_key: "1789370635".into(),
        })
        .unwrap();
        // 同行程重复回写（快照重放触发）幂等；新行程覆盖旧行程键
        db.save_workbuddy_travel_claim(&super::StoredWorkbuddyTravelClaim {
            instance_id: "inst-1".into(),
            claimed_key: "1789957341".into(),
        })
        .unwrap();
        let claim = db.get_workbuddy_travel_claim("inst-1").unwrap().unwrap();
        assert_eq!(claim.claimed_key, "1789957341");
        // 删实例级联清理判重行
        db.save_workbuddy_travel_claim(&super::StoredWorkbuddyTravelClaim {
            instance_id: "inst-2".into(),
            claimed_key: "1789370635".into(),
        })
        .unwrap();
        db.delete_instance("inst-1").unwrap();
        assert!(db.get_workbuddy_travel_claim("inst-1").unwrap().is_none());
        assert_eq!(
            db.get_workbuddy_travel_claim("inst-2").unwrap().unwrap().claimed_key,
            "1789370635"
        );
    }

    #[test]
    fn missing_row_returns_full_defaults() {
        let db = temp_db();
        let settings = db.get_settings().unwrap();
        // 默认快捷键随构建分流（ADR-0018）：debug 测试构建为 dev 默认值
        let expected_shortcut = if cfg!(debug_assertions) { "Control+Shift+KeyU" } else { "Alt+KeyU" };
        assert_eq!(settings.get("quickPanelShortcut").and_then(Value::as_str), Some(expected_shortcut));
        assert_eq!(settings.get("autoStart").and_then(Value::as_bool), Some(false));
        assert_eq!(settings.get("silentStart").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn old_row_missing_new_keys_gets_backfilled() {
        let db = temp_db();
        // 0.1.x 时代的行：只有旧键，没有 quickPanelShortcut 及之后引入的键
        db.save_settings(&json!({
            "refreshEnabled": true,
            "refreshIntervalMinutes": 30,
            "alertsEnabled": true
        }))
        .unwrap();
        let settings = db.get_settings().unwrap();
        // 缺失键补默认值 → 启动注册等后端消费方能取到默认快捷键（默认随构建分流，ADR-0018）
        let expected_shortcut = if cfg!(debug_assertions) { "Control+Shift+KeyU" } else { "Alt+KeyU" };
        assert_eq!(settings.get("quickPanelShortcut").and_then(Value::as_str), Some(expected_shortcut));
        assert_eq!(settings.get("autoStart").and_then(Value::as_bool), Some(false));
        // 已有键保留用户值，不被默认值覆盖
        assert_eq!(settings.get("refreshIntervalMinutes").and_then(Value::as_i64), Some(30));
    }

    #[test]
    fn explicit_values_are_never_overridden() {
        let db = temp_db();
        // 显式空串=用户禁用快捷键；显式 false=用户关闭自启——补默认值不得触碰它们
        db.save_settings(&json!({
            "refreshEnabled": false,
            "refreshIntervalMinutes": 15,
            "alertsEnabled": false,
            "quickPanelShortcut": "",
            "quickAutoHide": false,
            "resetTimeDisplay": "absolute",
            "interfaceLanguage": "en",
            "autoStart": true,
            "silentStart": true
        }))
        .unwrap();
        let settings = db.get_settings().unwrap();
        assert_eq!(settings.get("quickPanelShortcut").and_then(Value::as_str), Some(""));
        assert_eq!(settings.get("autoStart").and_then(Value::as_bool), Some(true));
        assert_eq!(settings.get("silentStart").and_then(Value::as_bool), Some(true));
        assert_eq!(settings.get("interfaceLanguage").and_then(Value::as_str), Some("en"));
    }
}
