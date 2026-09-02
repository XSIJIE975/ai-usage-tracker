use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;
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
    pub read: bool,
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
                id           TEXT PRIMARY KEY,
                provider_id  TEXT NOT NULL,
                note         TEXT NOT NULL DEFAULT '',
                sort_order   INTEGER NOT NULL DEFAULT 0,
                pinned       INTEGER NOT NULL DEFAULT 0,
                auto_refresh INTEGER NOT NULL DEFAULT 1,
                threshold    REAL,
                created_at   INTEGER NOT NULL
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
                read INTEGER NOT NULL DEFAULT 0
            );
            "#,
        )
        .map_err(|error| error.to_string())?;
        let db = Self { conn };
        db.rename_legacy_provider_columns()?;
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

    pub fn get_settings(&self) -> Result<Value, String> {
        let default = serde_json::json!({
            "refreshEnabled": true,
            "refreshIntervalMinutes": 5,
            "alertsEnabled": true,
            "quickPanelShortcut": "Alt+KeyU",
            "quickAutoHide": true,
            "interfaceLanguage": "auto"
        });
        let row = self
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'app_settings'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok();
        match row {
            Some(value) => serde_json::from_str(&value).map_err(|error| error.to_string()),
            None => Ok(default),
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
                SELECT id, provider_id, note, sort_order, pinned, auto_refresh, threshold, created_at
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
                    created_at: row.get(7)?,
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
                SELECT id, provider_id, note, sort_order, pinned, auto_refresh, threshold, created_at
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
                    created_at: row.get(7)?,
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
                        (id, provider_id, note, sort_order, pinned, auto_refresh, threshold, created_at)
                    VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
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
    ) -> Result<(), String> {
        let current = self
            .get_instance(id)?
            .ok_or_else(|| "实例不存在".to_string())?;
        // threshold 的三层语义：None=不改、Some(None)=清除、Some(Some(v))=设置
        self.conn
            .execute(
                r#"
                UPDATE provider_instances
                SET note = ?2, auto_refresh = ?3, pinned = ?4, threshold = ?5
                WHERE id = ?1
                "#,
                rusqlite::params![
                    id,
                    note.unwrap_or(&current.note),
                    auto_refresh.unwrap_or(current.auto_refresh) as i64,
                    pinned.unwrap_or(current.pinned) as i64,
                    threshold.unwrap_or(current.threshold),
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn reorder_instances(&self, ordered_ids: &[String]) -> Result<(), String> {
        let mut count = 0;
        for (index, id) in ordered_ids.iter().enumerate() {
            count += self
                .conn
                .execute(
                    "UPDATE provider_instances SET sort_order = ?2 WHERE id = ?1",
                    rusqlite::params![id, index as i64],
                )
                .map_err(|error| error.to_string())?;
        }
        if count != ordered_ids.len() {
            return Err("排序清单与现有实例不一致".to_string());
        }
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

    /// 写入一条告警通知，并按保留策略（30 天 / 200 条）清理旧数据
    pub fn add_notification(
        &self,
        instance_id: &str,
        title: &str,
        body: &str,
    ) -> Result<StoredNotification, String> {
        let created_at = chrono_utc_now();
        self.conn
            .execute(
                "INSERT INTO notifications(created_at, instance_id, title, body) VALUES(?1, ?2, ?3, ?4)",
                rusqlite::params![created_at, instance_id, title, body],
            )
            .map_err(|error| error.to_string())?;
        let id = self.conn.last_insert_rowid();

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

        Ok(StoredNotification {
            id,
            created_at,
            instance_id: instance_id.to_string(),
            title: title.to_string(),
            body: body.to_string(),
            read: false,
        })
    }

    pub fn list_notifications(&self, limit: i64) -> Result<Vec<StoredNotification>, String> {
        let mut statement = self
            .conn
            .prepare(
                r#"
                SELECT id, created_at, instance_id, title, body, read
                FROM notifications
                ORDER BY created_at DESC, id DESC
                LIMIT ?1
                "#,
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([limit], |row| {
                Ok(StoredNotification {
                    id: row.get(0)?,
                    created_at: row.get(1)?,
                    instance_id: row.get(2)?,
                    title: row.get(3)?,
                    body: row.get(4)?,
                    read: row.get::<_, i64>(5)? != 0,
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
