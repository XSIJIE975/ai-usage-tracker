# Use a master-password Credential Vault

Status: superseded by ADR-0007

敏感凭据使用应用自研 Vault 保存：主密码通过 Argon2id 派生 AES-256-GCM 密钥，凭据文件只保存加密后的数据，不依赖系统钥匙串。

## Considered Options

- 系统 Keychain / Credential Manager：安全但不符合用户选择的“自研加密存储”约束。
- 明文配置文件：实现简单但会直接暴露 API Key 和 Auth Cookie。
- 机器绑定密钥：使用方便但安全性较弱，迁移账号更麻烦。

## Consequences

- 用户每次启动或重启后需要输入主密码解锁。
- 如果忘记主密码，无法恢复已保存的凭据。
- Rust 侧负责密钥派生、加解密和内存清理，前端不接触明文凭据。
