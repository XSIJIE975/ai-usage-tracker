use std::path::PathBuf;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroize;

const VAULT_VERSION: u8 = 2;
const LEGACY_VAULT_VERSION: u8 = 1;
const KEY_LEN: usize = 32;
#[cfg(test)]
const LEGACY_SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;

#[derive(Serialize, Deserialize)]
struct VaultFile {
    version: u8,
    kdf: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    salt: Option<String>,
    nonce: String,
    ciphertext: String,
}

pub struct VaultState {
    pub initialized: bool,
    pub unlocked: bool,
    pub needs_migration: bool,
    pub keychain_lost: bool,
}

/// 设备密钥的存储后端。生产实现走系统钥匙串，测试用内存桩。
pub trait KeyStore: Send {
    /// 返回 None 表示钥匙串中没有设备密钥。
    fn load(&self) -> Result<Option<Vec<u8>>, String>;
    fn store(&self, key: &[u8]) -> Result<(), String>;
}

pub struct KeyringKeyStore {
    service: String,
    account: String,
}

impl KeyringKeyStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
            account: "device-key".to_string(),
        }
    }

    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, &self.account)
            .map_err(|error| format!("系统钥匙串不可用：{error}"))
    }
}

impl KeyStore for KeyringKeyStore {
    fn load(&self) -> Result<Option<Vec<u8>>, String> {
        match self.entry()?.get_secret() {
            Ok(mut secret) => {
                let result = Some(secret.clone());
                secret.zeroize();
                Ok(result)
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("读取系统钥匙串失败：{error}")),
        }
    }

    fn store(&self, key: &[u8]) -> Result<(), String> {
        self.entry()?
            .set_secret(key)
            .map_err(|error| format!("写入系统钥匙串失败：{error}"))
    }
}

pub struct Vault {
    path: PathBuf,
    keystore: Box<dyn KeyStore>,
    unlocked: bool,
    key: Option<[u8; KEY_LEN]>,
    credentials: Option<Value>,
}

impl Vault {
    pub fn new(path: PathBuf, keystore: Box<dyn KeyStore>) -> Self {
        Self {
            path,
            keystore,
            unlocked: false,
            key: None,
            credentials: None,
        }
    }

    pub fn exists(&self) -> bool {
        self.path.exists()
    }

    pub fn is_unlocked(&self) -> bool {
        self.unlocked
    }

    pub fn state(&self) -> VaultState {
        let initialized = self.exists();
        let needs_migration = initialized
            && read_vault_file(&self.path)
                .map(|file| file.version == LEGACY_VAULT_VERSION)
                .unwrap_or(false);
        VaultState {
            initialized,
            unlocked: self.unlocked,
            needs_migration,
            keychain_lost: initialized && !self.unlocked && !needs_migration,
        }
    }

    /// 启动时自动打开凭据库：新建、静默解锁，或保持待迁移状态。
    pub fn open(&mut self) -> Result<(), String> {
        if !self.exists() {
            return self.init_fresh();
        }
        let file = read_vault_file(&self.path)?;
        match file.version {
            LEGACY_VAULT_VERSION => Ok(()),
            VAULT_VERSION => self.unlock_with_device_key(&file),
            version => Err(format!("不支持的凭据库版本：{version}")),
        }
    }

    /// 一次性凭据库迁移：用旧主密码解密 v1 文件，改用设备密钥重新加密。
    pub fn migrate(&mut self, password: &str) -> Result<(), String> {
        if !self.exists() {
            return Err("Credential Vault 不存在，无需迁移".to_string());
        }
        let file = read_vault_file(&self.path)?;
        if file.version != LEGACY_VAULT_VERSION {
            return Err("Credential Vault 已是最新格式，无需迁移".to_string());
        }
        let salt = decode_b64(
            file.salt
                .as_deref()
                .ok_or_else(|| "旧凭据库文件缺少 salt".to_string())?,
        )?;
        let nonce = decode_b64(&file.nonce)?;
        let ciphertext = decode_b64(&file.ciphertext)?;
        let legacy_key = derive_legacy_key(password, &salt)?;
        let plaintext =
            decrypt(&legacy_key, &nonce, &ciphertext).map_err(|_| "主密码错误".to_string())?;
        let payload: Value =
            serde_json::from_slice(&plaintext).map_err(|error| error.to_string())?;

        let mut key_bytes = random_bytes(KEY_LEN);
        self.keystore.store(&key_bytes)?;
        let key = key_array(&key_bytes)?;
        key_bytes.zeroize();
        let nonce = random_bytes(NONCE_LEN);
        self.write_vault(&key, &nonce, &payload)?;
        self.key = Some(key);
        self.credentials = Some(payload);
        self.unlocked = true;
        Ok(())
    }

    pub fn ensure_unlocked(&mut self) -> Result<(), String> {
        if self.unlocked {
            return Ok(());
        }
        if !self.exists() {
            return self.init_fresh();
        }
        let file = read_vault_file(&self.path)?;
        match file.version {
            LEGACY_VAULT_VERSION => Err("请先完成凭据库迁移（设置 → 凭据库迁移）".to_string()),
            VAULT_VERSION => {
                self.unlock_with_device_key(&file)?;
                if self.unlocked {
                    return Ok(());
                }
                // 设备密钥丢失或密文损坏：凭据已不可恢复，重建空凭据库。
                self.init_fresh()
            }
            version => Err(format!("不支持的凭据库版本：{version}")),
        }
    }

    /// 凭据容器：v2 内层为 instances（按实例嵌套）；迁移窗口期兼容 v1 的扁平 credentials
    pub fn credentials(&self) -> Result<&Value, String> {
        self.credentials
            .as_ref()
            .and_then(|payload| payload.get("instances").or_else(|| payload.get("credentials")))
            .ok_or_else(|| "Credential Vault 未解锁".to_string())
    }

    /// 内层 payload 版本（1=扁平凭据、2=按实例嵌套）；未解锁返回 None
    pub fn inner_version(&self) -> Option<u8> {
        self.credentials
            .as_ref()
            .and_then(|payload| payload.get("version"))
            .and_then(Value::as_u64)
            .map(|version| version as u8)
    }

    /// credentials 参数为 v2 内层的 instances 对象（instanceId → {slot: value}）
    pub fn save_credentials(&mut self, credentials: &Value) -> Result<(), String> {
        self.ensure_unlocked()?;
        let key = self
            .key
            .as_ref()
            .ok_or_else(|| "Credential Vault 未解锁".to_string())?;
        let nonce = random_bytes(NONCE_LEN);
        let payload = serde_json::json!({
            "version": 2,
            "instances": credentials
        });
        self.write_vault(key, &nonce, &payload)?;
        self.credentials = Some(payload);
        Ok(())
    }

    fn init_fresh(&mut self) -> Result<(), String> {
        let mut key_bytes = random_bytes(KEY_LEN);
        self.keystore.store(&key_bytes)?;
        let key = key_array(&key_bytes)?;
        key_bytes.zeroize();
        let nonce = random_bytes(NONCE_LEN);
        let payload = serde_json::json!({
            "version": 2,
            "instances": {}
        });
        self.write_vault(&key, &nonce, &payload)?;
        self.key = Some(key);
        self.credentials = Some(payload);
        self.unlocked = true;
        Ok(())
    }

    fn unlock_with_device_key(&mut self, file: &VaultFile) -> Result<(), String> {
        let Some(mut secret) = self.keystore.load()? else {
            return Ok(());
        };
        let key_result = key_array(&secret);
        secret.zeroize();
        let key = key_result?;
        let nonce = decode_b64(&file.nonce)?;
        let ciphertext = decode_b64(&file.ciphertext)?;
        let plaintext = match decrypt(&key, &nonce, &ciphertext) {
            Ok(plaintext) => plaintext,
            Err(_) => return Ok(()),
        };
        let payload: Value =
            serde_json::from_slice(&plaintext).map_err(|error| error.to_string())?;
        self.key = Some(key);
        self.credentials = Some(payload);
        self.unlocked = true;
        Ok(())
    }

    fn write_vault(
        &self,
        key: &[u8; KEY_LEN],
        nonce: &[u8],
        payload: &Value,
    ) -> Result<(), String> {
        let plaintext = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
        let ciphertext = encrypt(key, nonce, &plaintext)?;
        let file = VaultFile {
            version: VAULT_VERSION,
            kdf: "device-key".to_string(),
            salt: None,
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
        };
        let json = serde_json::to_vec_pretty(&file).map_err(|error| error.to_string())?;
        std::fs::write(&self.path, json).map_err(|error| error.to_string())
    }
}

impl Drop for Vault {
    fn drop(&mut self) {
        if let Some(mut key) = self.key.take() {
            key.zeroize();
        }
    }
}

fn read_vault_file(path: &PathBuf) -> Result<VaultFile, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

/// 旧版主密码的 KDF，仅用于凭据库迁移（测试借它构造历史 vault 文件）。
pub(crate) fn derive_legacy_key(password: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], String> {
    let params = Params::new(19_456, 2, 1, Some(KEY_LEN)).map_err(|error| error.to_string())?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; KEY_LEN];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|error| error.to_string())?;
    Ok(key)
}

fn key_array(bytes: &[u8]) -> Result<[u8; KEY_LEN], String> {
    bytes
        .try_into()
        .map_err(|_| "设备密钥长度异常，请重新保存凭据".to_string())
}

pub(crate) fn encrypt(key: &[u8; KEY_LEN], nonce: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .encrypt(Nonce::from_slice(nonce), plaintext)
        .map_err(|_| "加密失败".to_string())
}

fn decrypt(key: &[u8; KEY_LEN], nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| "解密失败".to_string())
}

fn random_bytes(len: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; len];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes
}

fn decode_b64(input: &str) -> Result<Vec<u8>, String> {
    BASE64.decode(input).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
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

    fn temp_vault_path() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-usage-vault-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("vault.json")
    }

    fn write_legacy_vault(path: &PathBuf, password: &str, credentials: &Value) {
        let salt = random_bytes(LEGACY_SALT_LEN);
        let nonce = random_bytes(NONCE_LEN);
        let key = derive_legacy_key(password, &salt).unwrap();
        let payload = serde_json::json!({
            "version": 1,
            "credentials": credentials
        });
        let plaintext = serde_json::to_vec(&payload).unwrap();
        let ciphertext = encrypt(&key, &nonce, &plaintext).unwrap();
        let file = serde_json::json!({
            "version": 1,
            "kdf": "argon2id",
            "salt": BASE64.encode(&salt),
            "nonce": BASE64.encode(&nonce),
            "ciphertext": BASE64.encode(&ciphertext),
        });
        std::fs::write(path, serde_json::to_vec_pretty(&file).unwrap()).unwrap();
    }

    #[test]
    fn opens_fresh_vault_without_any_prompt() {
        let path = temp_vault_path();
        let mut vault = Vault::new(path.clone(), Box::new(MemoryKeyStore::default()));

        vault.open().unwrap();
        assert!(vault.is_unlocked());
        let state = vault.state();
        assert!(state.initialized && state.unlocked && !state.needs_migration && !state.keychain_lost);

        let mut reopened = Vault::new(path, Box::new(MemoryKeyStore::default()));
        assert!(reopened.open().is_ok());
        assert!(!reopened.is_unlocked(), "key missing from keystore means locked");
        let state = reopened.state();
        assert!(state.keychain_lost);
    }

    #[test]
    fn device_key_round_trip_across_restarts() {
        let path = temp_vault_path();
        let keystore = MemoryKeyStore::default();

        let mut vault = Vault::new(path.clone(), Box::new(keystore.clone()));
        vault.open().unwrap();
        vault
            .save_credentials(&serde_json::json!({ "deepseekApiKey": "sk-test" }))
            .unwrap();

        let mut reopened = Vault::new(path, Box::new(keystore));
        reopened.open().unwrap();
        assert!(reopened.is_unlocked());
        assert_eq!(
            reopened.credentials().unwrap()["deepseekApiKey"],
            serde_json::json!("sk-test")
        );
    }

    #[test]
    fn save_after_keychain_loss_rebuilds_empty_vault() {
        let path = temp_vault_path();
        let mut vault = Vault::new(path.clone(), Box::new(MemoryKeyStore::default()));
        vault.open().unwrap();
        vault
            .save_credentials(&serde_json::json!({ "deepseekApiKey": "sk-old" }))
            .unwrap();
        drop(vault);

        // 钥匙串丢失（换机/重装）：文件还在，密钥没了。
        let mut stranded = Vault::new(path.clone(), Box::new(MemoryKeyStore::default()));
        stranded.open().unwrap();
        assert!(!stranded.is_unlocked());
        assert!(stranded.state().keychain_lost);

        stranded
            .save_credentials(&serde_json::json!({ "deepseekApiKey": "sk-new" }))
            .unwrap();
        assert!(stranded.is_unlocked());
        assert_eq!(
            stranded.credentials().unwrap()["deepseekApiKey"],
            serde_json::json!("sk-new")
        );

        let mut reopened = Vault::new(path, Box::new(MemoryKeyStore::default()));
        assert!(reopened.open().is_err() || !reopened.is_unlocked());
    }

    #[test]
    fn migrates_legacy_password_vault_to_device_key() {
        let path = temp_vault_path();
        write_legacy_vault(
            &path,
            "correct-horse",
            &serde_json::json!({ "deepseekApiKey": "sk-legacy" }),
        );
        let keystore = MemoryKeyStore::default();

        let mut vault = Vault::new(path.clone(), Box::new(keystore.clone()));
        vault.open().unwrap();
        assert!(!vault.is_unlocked());
        let state = vault.state();
        assert!(state.needs_migration && !state.keychain_lost);

        assert_eq!(vault.migrate("wrong-password"), Err("主密码错误".to_string()));
        vault.migrate("correct-horse").unwrap();
        assert!(vault.is_unlocked());
        assert_eq!(
            vault.credentials().unwrap()["deepseekApiKey"],
            serde_json::json!("sk-legacy")
        );

        let file = read_vault_file(&path).unwrap();
        assert_eq!(file.version, VAULT_VERSION);
        assert!(file.salt.is_none());

        // 迁移后重启：静默解锁，无需任何密码。
        let mut reopened = Vault::new(path, Box::new(keystore));
        reopened.open().unwrap();
        assert!(reopened.is_unlocked());
        assert_eq!(
            reopened.credentials().unwrap()["deepseekApiKey"],
            serde_json::json!("sk-legacy")
        );
    }

    #[test]
    fn save_is_blocked_until_legacy_vault_is_migrated() {
        let path = temp_vault_path();
        write_legacy_vault(&path, "correct-horse", &serde_json::json!({}));

        let mut vault = Vault::new(path, Box::new(MemoryKeyStore::default()));
        vault.open().unwrap();
        let error = vault
            .save_credentials(&serde_json::json!({ "deepseekApiKey": "sk-x" }))
            .unwrap_err();
        assert!(error.contains("凭据库迁移"));
    }
}
