# 凭据目的地面：按供应商种类收敛目标域名

Status: accepted

## Context

`provider_request` 的目标地址取自调用方且不校验，也就是「凭据会被发往哪个域」这件事实际由前端决定。要收敛它，先划清这层能挡到哪、不能挡到哪：

- **槽位维度已有边界**：`(kind, credential_slot)` 是显式表（`credential_label`），拿 A 供应商的实例去取 B 供应商的凭据本来就做不到。本 ADR 补的是目的地维度。
- **目的地白名单是纵深防御，不是完整边界**：凭据的读取与注入全在 Rust 侧，但一旦渲染进程被任意脚本控制，后果不止于「它能不能借这两个命令发请求」。把这层当成边界会高估它，所以定位写清楚：它解决的是「应用自己把凭据发去哪由谁决定」。
- **注入前提目前没有已知达成路径**：取数结果只作为 React 文本节点渲染（默认转义），唯一的富文本面按 ADR-0028 的口径处理。

故这是一次成本低、边界清楚的纵深加固，不是紧急修补；顺带的取舍是不改动凭据录入与编辑的交互。

而且收敛的条件很好：全仓带凭据的出口只有 `provider_request` 与 `diagnose_request` 两个命令，19 个 `provider_request` 调用点的 url 全是编译期常量（唯二拼接处 host 固定），也没有任何用户可填端点的设置项——白名单可以做成静态表，零功能风险。

## Decision

**目的地面在 Rust 侧按供应商种类收敛，前端不参与。**

1. `instances.rs` 新增 `ALLOWED_HOSTS`：`kind → 主机名列表`，与既有的槽位表 `credential_label(kind, slot)` 同形并排。9 个 host 覆盖五个种类（deepseek 2 / opencode-go 1 / glm 2 / workbuddy 2 / qoder 2）。
2. `provider_request` 取出实例种类后、拼请求前调 `validate_request_url(kind, url)`；`diagnose_request` 没有实例上下文（凭据是用户刚粘贴、尚未保存的那一份），用五类全集 `validate_probe_url`。跨种类一律拒——拿 glm 的 key 去打 workbuddy.cn 也算凭据离开所属供应商。
3. 校验口径：`Url::parse` 必须成功、方案必须是 https、主机名与表内条目**精确相等**（不做后缀匹配，`www.workbuddy.cn.evil.com` 必须被拒；带尾点的 FQDN 不匹配即拒，属 fail-closed）、拒 userinfo、拒显式端口。种类未登记一律硬拒——接第 6 个供应商时漏登记会直接报错，而不是静默放行。
4. HTTP 客户端加 `.https_only(true)`：实测 reqwest 对初始请求（`async_impl/client.rs` 的 `execute_request`）与重定向（`redirect.rs` 的 `check`）两处都校验方案，挡掉合法域被劫持成 `http://` 的降级。跨 host 重定向时 reqwest 自己会剥 `Cookie`/`Authorization`（`redirect.rs` 的 `remove_sensitive_headers`），所以白名单不必为跳转再补一层。
5. 漂移守卫 `src/providers/allowed-hosts.test.ts`：解析 `ALLOWED_HOSTS`，扫 `src/providers/*.ts`（排除测试）与 `src/diagnostics.ts` 的 URL 字面量，按文件名前缀归到种类后断言子集关系，种类集合还与前端 `providerModules` 一一对应。加了新端点却忘登记时测试先红，而不是等用户看到「拒绝向 xxx 发请求」。

## Considered Options

- **全局扁平 host 集（不分种类）**：省一层 `match`，但白名单与 `kind` 解耦，跨种类端点照样放行，「凭据只去它所属的供应商」这条就没了。
- **同时收窄渲染进程的凭据可见性**（编辑弹窗改成「已配置，重新粘贴以覆盖」，取数侧只读配置状态）：动的是前提本身，但代价是用户可见的录入交互变化、双语文案与多处调用点重构；且做完后仍挡不住拿合法端点滥用账号（读余额、签到、领权益）——泄露收小了、滥用没变，性价比最低。留作后续。
- **加 CSP 并收窄 `connect-src`**：这是唯一能同时管住「渲染进程自己发请求」的控制，实际价值比本 ADR 更高，但写窄了会连带切断渲染进程与后端的通信通道，必须真机三个窗口回归。留作后续，随下一次带真机验证的批次一起做。
- **只记文档不改代码**：白名单确实不是完整边界。但成本只有几十行，而且「由谁决定凭据发去哪」这个方向上只有这一步能落地。

## Consequences

- 接新供应商要登记两处：`credential_label`（槽位面）与 `ALLOWED_HOSTS`（目的地面）。漏登记时 Rust 的 `every_provider_kind_registers_hosts` 与 vitest 的种类一一对应断言都会红。
- 若将来真要支持自建网关 / 用户自填 baseUrl，本表要升级成「按实例登记允许域」的配置，并且必须同时把 CSP 那条补上——否则白名单只剩形式意义。
- 本 ADR 收敛的是目的地，不改变更大的前提：渲染进程被任意脚本控制之后，后果不由这一层决定。要继续压这一层，看上面两条留待项（收窄凭据可见性、CSP）。
- 报错文案留在 Rust 侧的中文常量里，与既有的网络失败类别摘要同口径（那批也没有英文化），不新增 i18n 词条。
