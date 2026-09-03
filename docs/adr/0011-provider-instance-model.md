# 供应商拆分为种类与实例的双层模型

Status: accepted

## Context

0.3.x 把「供应商」当成固定三元素集合：`providerModules = [opencode-go, deepseek, glm]`，`providerId` 一个字符串同时充当快照表主键、通知表列、告警状态键、刷新中状态键、自动刷新开关（settings.providers）与后端凭据解析入口。结果是用户无法同时追踪两个 DeepSeek 账号——它们会共用一份凭据、一张卡片、一套阈值与一份告警冷却。此外总览卡片、统计、刷新的粒度都被锁死在种类级。

## Decision

- 领域模型拆为两层：**供应商（种类）**是内置的取数定义；**供应商实例**是一份可重复的配置（凭据槽位集合、备注、阈值、自动刷新开关、排序与置顶），卡片、快照、通知、统计、告警、刷新状态全部以实例为单位。
- 实例非机密元数据存 SQLite 新表 `provider_instances`；凭据仍留加密凭据库，内层 payload 从扁平 6 键升级为按 instanceId 嵌套（`{version: 2, instances: {id: {slot: value}}}`），长字段名收敛为凭据槽位（`apiKey` / `userToken` / `workspaceId` / `cookie` / `planKey`）。
- 迁移：为每个「已有凭据」的种类自动建实例，**实例 id 沿用旧种类字符串**（`deepseek` / `opencode-go` / `glm`），`snapshots` / `notifications` 表用 `RENAME COLUMN provider_id → instance_id` 零改写继承全部历史；阈值与自动刷新开关从旧 `settings.alertThresholds` / `settings.providers` 字段继承后删掉这两个字段。此后新建实例用 UUIDv4。
- 告警阈值与自动刷新全部下沉到实例行；IPC 面以实例为参数（`provider_request(instanceId, …, credentialSlot?)`），DeepSeek 统计的伪种类 `deepseek-platform` 消失，改传 `credentialSlot: "userToken"`。

## Consequences

- **老实例的 id 长得像 `deepseek` 而新实例是 UUID**——这是历史包袱换来的红利：快照与通知一行不改，升级零感知；读者若在快照表里看到非 UUID 的 instance_id，它就是迁移前「供应商即实例」时代的存量行。
- 凭据库内层从 v1 升到 v2 后旧版本程序读不了，不留兼容垫片（与仓库纪律一致）；风险靠升级前备份与阶段化提交控制。
- `settings.providers` / `settings.alertThresholds` 废除，相关设置界面（供应商页签）被实例配置弹窗取代；同种类多实例的统计缓存必须以 instanceId 为前缀，否则互相串数据。
- 放弃的备选：全塞 settings JSON（凭据仍在 vault，两处状态难以原子）、全塞 vault（非机密元数据放进加密文件，无法被 SQL 查询与索引）、全部新 UUID 并改写历史快照（要批量 UPDATE 六千余行且破坏「行数据零改写」）。
