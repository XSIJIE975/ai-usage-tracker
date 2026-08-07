use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
pub struct StoredSnapshot {
    pub provider_id: String,
    pub captured_at: i64,
    pub payload: Value,
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

            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_id TEXT NOT NULL,
                captured_at INTEGER NOT NULL,
                payload TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_snapshots_provider_id
                ON snapshots(provider_id, id DESC);
            "#,
        )
        .map_err(|error| error.to_string())?;
        Ok(Self { conn })
    }

    pub fn get_settings(&self) -> Result<Value, String> {
        let default = serde_json::json!({
            "refreshEnabled": true,
            "refreshIntervalMinutes": 5,
            "providers": {
                "opencode-go": true,
                "deepseek": true
            }
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

    pub fn save_snapshot(&self, provider_id: &str, payload: &Value) -> Result<(), String> {
        let captured_at = payload
            .get("updatedAt")
            .and_then(Value::as_i64)
            .unwrap_or_else(|| chrono_utc_now());
        let body = serde_json::to_string(payload).map_err(|error| error.to_string())?;
        self.conn
            .execute(
                "INSERT INTO snapshots(provider_id, captured_at, payload) VALUES(?1, ?2, ?3)",
                rusqlite::params![provider_id, captured_at, body],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn get_latest_snapshots(&self) -> Result<Vec<StoredSnapshot>, String> {
        let mut statement = self
            .conn
            .prepare(
                r#"
                SELECT s.provider_id, s.captured_at, s.payload
                FROM snapshots s
                JOIN (
                    SELECT provider_id, MAX(id) AS max_id
                    FROM snapshots
                    GROUP BY provider_id
                ) latest ON latest.max_id = s.id
                ORDER BY s.provider_id
                "#,
            )
            .map_err(|error| error.to_string())?;

        let rows = statement
            .query_map([], |row| {
                Ok(StoredSnapshot {
                    provider_id: row.get(0)?,
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
}

fn chrono_utc_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
