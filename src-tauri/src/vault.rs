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

const VAULT_VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;

#[derive(Serialize, Deserialize)]
struct VaultFile {
    version: u8,
    kdf: String,
    salt: String,
    nonce: String,
    ciphertext: String,
}

pub struct Vault {
    path: PathBuf,
    unlocked: bool,
    key: Option<[u8; 32]>,
    credentials: Option<Value>,
}

impl Vault {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
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

    pub fn init(&mut self, password: &str) -> Result<(), String> {
        if self.exists() {
            return Err("Credential Vault 已初始化".to_string());
        }
        let salt = random_bytes(SALT_LEN);
        let nonce = random_bytes(NONCE_LEN);
        let key = derive_key(password, &salt)?;
        let payload = serde_json::json!({
            "version": 1,
            "credentials": {}
        });
        self.write_vault(&key, &salt, &nonce, &payload)?;
        self.key = Some(key);
        self.credentials = Some(payload);
        self.unlocked = true;
        Ok(())
    }

    pub fn unlock(&mut self, password: &str) -> Result<(), String> {
        if !self.exists() {
            return Err("Credential Vault 尚未初始化".to_string());
        }
        let file = read_vault_file(&self.path)?;
        let salt = decode_b64(&file.salt)?;
        let nonce = decode_b64(&file.nonce)?;
        let ciphertext = decode_b64(&file.ciphertext)?;
        let key = derive_key(password, &salt)?;
        let plaintext = decrypt(&key, &nonce, &ciphertext)?;
        let payload: Value =
            serde_json::from_slice(&plaintext).map_err(|error| error.to_string())?;
        self.key = Some(key);
        self.credentials = Some(payload);
        self.unlocked = true;
        Ok(())
    }

    pub fn lock(&mut self) {
        self.unlocked = false;
        if let Some(mut key) = self.key.take() {
            key.zeroize();
        }
        self.credentials = None;
    }

    pub fn credentials(&self) -> Result<&Value, String> {
        self.credentials
            .as_ref()
            .and_then(|payload| payload.get("credentials"))
            .ok_or_else(|| "Credential Vault 未解锁".to_string())
    }

    pub fn save_credentials(&mut self, credentials: &Value) -> Result<(), String> {
        let key = self
            .key
            .as_ref()
            .ok_or_else(|| "Credential Vault 未解锁".to_string())?;
        if !self.exists() {
            return Err("Credential Vault 文件不存在".to_string());
        }
        let file = read_vault_file(&self.path)?;
        let salt = decode_b64(&file.salt)?;
        let nonce = random_bytes(NONCE_LEN);
        let payload = serde_json::json!({
            "version": 1,
            "credentials": credentials
        });
        self.write_vault(key, &salt, &nonce, &payload)?;
        self.credentials = Some(payload);
        Ok(())
    }

    fn write_vault(
        &self,
        key: &[u8; 32],
        salt: &[u8],
        nonce: &[u8],
        payload: &Value,
    ) -> Result<(), String> {
        let plaintext = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
        let ciphertext = encrypt(key, nonce, &plaintext)?;
        let file = VaultFile {
            version: VAULT_VERSION,
            kdf: "argon2id".to_string(),
            salt: BASE64.encode(salt),
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
        };
        let json = serde_json::to_vec_pretty(&file).map_err(|error| error.to_string())?;
        std::fs::write(&self.path, json).map_err(|error| error.to_string())
    }
}

fn read_vault_file(path: &PathBuf) -> Result<VaultFile, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let params = Params::new(19_456, 2, 1, Some(32)).map_err(|error| error.to_string())?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|error| error.to_string())?;
    Ok(key)
}

fn encrypt(key: &[u8; 32], nonce: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .encrypt(Nonce::from_slice(nonce), plaintext)
        .map_err(|_| "加密失败".to_string())
}

fn decrypt(key: &[u8; 32], nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| "主密码错误".to_string())
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
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn vault_round_trip() {
        let dir = std::env::temp_dir().join(format!(
            "ai-usage-vault-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("vault.json");

        let mut vault = Vault::new(path.clone());
        vault.init("correct-horse").unwrap();
        let credentials = serde_json::json!({
            "deepseekApiKey": "sk-test"
        });
        vault.save_credentials(&credentials).unwrap();
        assert!(vault.is_unlocked());

        let mut locked = Vault::new(path);
        assert!(locked.unlock("wrong").is_err());
        locked.unlock("correct-horse").unwrap();
        assert_eq!(
            locked.credentials().unwrap()["deepseekApiKey"],
            serde_json::json!("sk-test")
        );

        std::fs::remove_dir_all(dir).unwrap();
    }
}
