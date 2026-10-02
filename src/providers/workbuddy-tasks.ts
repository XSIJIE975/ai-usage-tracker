import { invoke } from "@tauri-apps/api/core";
import type { HttpResult, ProviderInstance } from "../types/ipc";
import {
  BILLING_ORIGIN,
  GROWTH_ORIGIN,
  WEB_ORIGIN,
} from "./workbuddy-channel";
import {
  createGrowthContext,
  type GrowthContext,
  type WorkbuddyAccount,
} from "./workbuddy-growth";

// WorkBuddy 成长任务（ADR-0036）：一次性激励任务的展示与「纯上报类」自动完成。
// 机制与事件形状全部照抄参考实现 linguo2625469/workbuddy2api-panel（taskcenter.go /
// autotask.go / tasks.go / report.go / desktop.go / school.go，克隆对表 2026-09-26），
// Cookie 通道三关（列表/上报/领奖）用户真机 spike 实证（2026-09-26）。
// 通道上下文与账号摘要自 ADR-0037 起收敛到 workbuddy-growth.ts（GrowthContext），
// 本文件只保留动作表、事件构造与任务域的域分流。
//
// 四条接口（国区；国际站无成长体系，能力位整段门掉）：
// - 任务列表 GET copilot.tencent.com/v2/activity/growth/tasks（growth 域带 /v2 前缀，
//   与 travel/streak 的无前缀不同——参考 tasks.go tasksListPath）；mp 口径同 URL 叠加
//   X-Client-Platform: miniprogram，两口径大体重叠、各有专属任务，按 task_code 去重
//   合并（2026-10-02 实抓：默认口径可见的体验类任务不在 mp 口径，「mp 超集」不成立）
// - 接受任务 POST .../tasks/accept {"task_codes":[...]}（幂等报名）：上游对
//   not_accepted 的任务不计数（参考 taskcenter.go 队列前置 acceptPendingTasks——
//   漏了这步的表现就是上报 200 但进度不动、无法领奖），mp 任务执行前带回读验证，
//   default 口径任务执行前尽力而为（acceptDefaultTask）
// - 行为事件上报 POST {codebuddy.cn|copilot.tencent.com|workbuddy.cn}/v2/report——
//   点亮判据。事件体必带 userId（uid）；桌面/mp 指纹的 machineId 等设备标识由 uid
//   派生。**token 通道 uid 在 vault 前端拿不到明文**：事件体以 {{WB_UID}} 等占位符
//   书写，由 Rust workbuddy_report 分支发送前替换（ADR-0036）；Cookie 通道前端从
//   console/account 拿 uid/nickname 后自行替换
// - 领奖 POST www.workbuddy.cn/activity/growth/tasks/{code}/claim（web 头，幂等，
//   already_claimed 不算错）；mp 任务走 copilot 域 + miniprogram 头，400 时降级 web 路径

/** 事件体里的凭据占位符（token 通道由 Rust 替换；Cookie 通道前端替换） */
const UID_PLACEHOLDER = "{{WB_UID}}";
const NICKNAME_PLACEHOLDER = "{{WB_NICKNAME}}";
const MACHINE_ID_PLACEHOLDER = "{{WB_MACHINE_ID}}";
const SESSION_ID_PLACEHOLDER = "{{WB_SESSION_ID}}";
const WEB_MACHINE_ID_PLACEHOLDER = "{{WB_WEB_MACHINE_ID}}";

// ─── 头族（静态协议头；Cookie/Authorization/User-Agent/X-User-Id 等凭据衍生头由
// Rust auth 分支注入，X-User-Id 在 Cookie 通道由这里带 uid 传入——它不是保留头）───

/** growth 域任务接口（Cookie 通道形态，用户 spike 实证；Referer 对应成长中心页）。
 *  x-client-platform 键用驼峰大写：与 mpListHeader 合并时靠同名覆盖，避免大小写
 *  不同的两个键发出两个 x-client-platform 头（reqwest 视为同名 append） */
const taskHeadersCookie = {
  Accept: "application/json",
  Origin: WEB_ORIGIN,
  Referer: `${WEB_ORIGIN}/profile/growth-center`,
  "X-Client-Platform": "web",
};
/** growth 域任务接口（token 通道形态：参考 growthJSON/BillingHeaders，不带 Origin/Referer） */
const taskHeadersToken = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "X-CodeBuddy-Request": "1",
  "X-Domain": "www.codebuddy.cn",
};
/** mp 口径叠加头（任务列表/accept/claim 用 miniprogram；report 用的是 mp-weixin，两套值勿混） */
const mpListHeader = { "X-Client-Platform": "miniprogram" };
/** web 域领奖（参考 ClaimReward 浏览器形态） */
const claimHeadersWeb = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  Origin: WEB_ORIGIN,
  Referer: `${WEB_ORIGIN}/profile/growth-center`,
  "x-client-platform": "web",
};
/** 桌面指纹上报静态头（copilot 域，token 通道专用；X-User-Id 由 Rust 注入） */
const desktopReportHeaders = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json;charset=UTF-8",
  "X-Domain": GROWTH_ORIGIN,
  "X-Product": "SaaS",
};
/** chat 活跃上报（billing 域；Cookie 通道形态 = spike 第二关实证组合） */
const chatReportHeadersCookie = {
  Accept: "application/json",
  "Content-Type": "application/json",
  Origin: WEB_ORIGIN,
  Referer: `${WEB_ORIGIN}/profile/plans-usage`,
  "x-client-platform": "web",
};
/** chat 活跃上报（token 通道形态，billing 头族） */
const chatReportHeadersToken = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "X-CodeBuddy-Request": "1",
  "X-Domain": "www.codebuddy.cn",
};
/** mp 指纹上报（codebuddy.cn；参考 ReportMPEvent 头组） */
const mpReportHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "X-Client-Product": "workbuddy-mp",
  "X-Client-Version": "2.4.0",
  "X-Client-Platform": "mp-weixin",
  "X-Platform": "wechatmp",
};

// ─── 任务类型与口径 ───

/** 单个成长任务（面板展示口径；progress 平铺与 {current,target} 对象两形状都解析） */
export interface WorkbuddyTask {
  taskCode: string;
  title: string;
  description: string;
  rewardCredit: number;
  rewardEnergy: number;
  target: number;
  current: number;
  acceptStatus: string;
  claimed: boolean;
  /** 本地推算：达标（target>0 且 current>=target）且未领取 */
  claimable: boolean;
  locked: boolean;
  /** 小程序口径专属（列表来自 mp 头那次拉取；accept/领奖路径随口径分叉） */
  isMp: boolean;
}

/** 真实对话类任务码（ADR-0036：永不自动执行——判据要真实 chat 消耗积分；
 *  达标未领时以「可领取」形态出现，仅开放代领） */
const CLAIMABLE_ONLY_CODES = new Set([
  "Model_chat_GLM5.2",
  "expert_5",
  "Expert_team_use_3",
  "Expert_lighthouse",
  "skill_1",
  "black_cat",
]);

// ─── Cookie 通道的账号信息（uid 来源；ADR-0037 起归 growth 层所有）───

/** 由 uid 派生 36 位 hex 设备标识（参考 desktop.go deriveID 同款：sha256(salt:uid)
 *  前 18 字节；同一账号恒定同一标识——Cookie 通道前端算，token 通道 Rust 算同款） */
export async function deriveDeviceId(uid: string, salt: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${salt}:${uid}`),
    );
    return Array.from(new Uint8Array(digest).slice(0, 18))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    throw new TaskActionError("设备标识生成失败，请重启程序后重试");
  }
}

/** Cookie 通道的事件体占位符替换（token 通道原样发出，Rust 替换同款占位符） */
async function fillPlaceholders(body: string, account: WorkbuddyAccount): Promise<string> {
  const escapedNickname = JSON.stringify(account.nickname).slice(1, -1);
  const [machineId, sessionId, webMachineId] = await Promise.all([
    deriveDeviceId(account.uid, "machine"),
    deriveDeviceId(account.uid, "session"),
    deriveDeviceId(account.uid, "webmachine"),
  ]);
  return body
    .split(UID_PLACEHOLDER).join(account.uid)
    .split(NICKNAME_PLACEHOLDER).join(escapedNickname)
    .split(MACHINE_ID_PLACEHOLDER).join(machineId)
    .split(SESSION_ID_PLACEHOLDER).join(sessionId)
    .split(WEB_MACHINE_ID_PLACEHOLDER).join(webMachineId);
}

// ─── 通道上下文与请求原语（GrowthContext 自 ADR-0037 起在 workbuddy-growth.ts）───

/** 任务会话的通道上下文 = 成长中心上下文（instance/channel/site/capabilities/account）。 */
export type TaskContext = GrowthContext;

/** 建立任务上下文（严格口径）：token 槽非空即 token 通道（ADR-0035 互斥读出）；
 *  Cookie 通道必须有账号摘要（console/account 失败返回 null——上层按「账号信息获取
 *  失败」报错，不静默；取数链用的是宽松口径 createGrowthContext） */
export async function createTaskContext(
  instance: ProviderInstance,
): Promise<TaskContext | null> {
  const ctx = await createGrowthContext(instance);
  if (!ctx) return null;
  if (ctx.channel === "cookie" && !ctx.account) return null;
  return ctx;
}

interface TaskRequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  bodyText?: string;
}

/** 任务域统一出站：按通道选 auth（列表/accept/claim/growth 写动作）；Cookie 通道
 *  的事件体占位符在此替换。事件上报（report 族）不走这里——它们的 auth 与头族
 *  按"事件指纹"而非"通道"取（见 reportAuthFor 与各 report 原语） */
async function taskRequest(
  ctx: TaskContext,
  url: string,
  options: TaskRequestOptions = {},
): Promise<HttpResult> {
  const bodyText =
    options.bodyText && ctx.channel === "cookie" && ctx.account
      ? await fillPlaceholders(options.bodyText, ctx.account)
      : options.bodyText;
  return invoke<HttpResult>("provider_request", {
    instanceId: ctx.instance.id,
    url,
    method: options.method ?? "GET",
    auth: authFor(ctx),
    headers: options.headers,
    bodyText,
  });
}

/** auth 选择：Cookie 通道恒 session_cookie；token 通道事件上报走 workbuddy_report
 *  （Rust 替换占位符 + 按域注入桌面/billing UA），其余走 workbuddy_token */
function authFor(ctx: TaskContext): string {
  return ctx.channel === "cookie" ? "session_cookie" : "workbuddy_token";
}

function reportAuthFor(ctx: TaskContext): string {
  return ctx.channel === "cookie" ? "session_cookie" : "workbuddy_report";
}

// ─── 信封与任务解析 ───

interface WorkbuddyEnvelope {
  code?: number | string;
  msg?: string;
  data?: unknown;
}

/** 业务信封判定：HTTP 200 且 code∈{0,200} 视为成功并给 data，否则给上游 msg。
 *  自造 detail 用语言中性写法（code 10001 / invalid response），进 {detail} 不经翻译 */
function unwrapEnvelope(result: HttpResult): { ok: boolean; data?: unknown; msg: string } {
  if (result.status !== 200) return { ok: false, msg: `HTTP ${result.status}` };
  try {
    const json = JSON.parse(result.bodyText) as WorkbuddyEnvelope;
    const rawCode = json.code;
    const code =
      typeof rawCode === "string" ? (rawCode.trim() === "" ? NaN : Number(rawCode)) : rawCode;
    if (code === 0 || code === 200) return { ok: true, data: json.data, msg: json.msg ?? "" };
    return { ok: false, msg: json.msg || (code === undefined ? "invalid response" : `code ${code}`) };
  } catch {
    return { ok: false, msg: "invalid response" };
  }
}

interface RawTask {
  task_code?: string;
  title?: string;
  description?: string;
  task_desc?: string;
  reward_credit?: number;
  reward_energy?: number;
  target?: number;
  current?: number;
  progress?: { current?: number; target?: number } | null;
  accept_status?: string;
  locked?: boolean;
}

/** 单口径任务列表解析（默认与 mp 共用；progress 对象形状覆盖平铺字段） */
export function parseGrowthTasks(data: unknown, isMp: boolean): WorkbuddyTask[] {
  const tasks = (data as { tasks?: RawTask[] } | undefined)?.tasks ?? [];
  return tasks.flatMap((raw) => {
    const taskCode = raw.task_code ?? "";
    if (!taskCode) return [];
    let current = raw.current ?? 0;
    let target = raw.target ?? 0;
    if (raw.progress && (raw.progress.target ?? 0) > 0) {
      current = raw.progress.current ?? 0;
      target = raw.progress.target ?? 0;
    }
    const claimed = raw.accept_status === "claimed";
    return [{
      taskCode,
      title: raw.title ?? "",
      description: raw.description || raw.task_desc || "",
      rewardCredit: raw.reward_credit ?? 0,
      rewardEnergy: raw.reward_energy ?? 0,
      target,
      current,
      acceptStatus: raw.accept_status ?? "",
      claimed,
      claimable: !claimed && target > 0 && current >= target,
      locked: Boolean(raw.locked),
      isMp,
    }];
  });
}

/** 拉取任务列表（scope: all=面板展示双口径合并；default/mp=回读单口径——findTask
 *  按 isMp 只拉需要的那一口径，一轮一键完成的列表 GET 从 120+ 收敛到几十）。
 *  mp 是默认口径超集，all 时按 task_code 去重、默认口径优先；mp 拉取失败静默。
 *  error 是中文模板（{detail} 包上游原文），与 errorParams 一起由渲染层出文案 */
export async function fetchWorkbuddyTasks(
  ctx: TaskContext,
  scope: "all" | "default" | "mp" = "all",
): Promise<{ tasks: WorkbuddyTask[]; error?: string; errorParams?: Record<string, string | number> }> {
  const baseHeaders =
    ctx.channel === "cookie" ? taskHeadersCookie : taskHeadersToken;
  const listUrl = `${GROWTH_ORIGIN}/v2/activity/growth/tasks`;
  const listError = (msg: string) => ({
    tasks: [] as WorkbuddyTask[],
    error: "任务列表获取失败：{detail}",
    errorParams: msg ? { detail: msg } : undefined,
  });
  if (scope === "mp") {
    const mpResult = await taskRequest(ctx, listUrl, {
      method: "GET",
      headers: { ...baseHeaders, ...mpListHeader },
    });
    const mpEnvelope = unwrapEnvelope(mpResult);
    if (!mpEnvelope.ok) return listError(mpEnvelope.msg);
    return { tasks: parseGrowthTasks(mpEnvelope.data, true) };
  }
  const defaultResult = await taskRequest(ctx, listUrl, {
    headers: baseHeaders,
  });
  const envelope = unwrapEnvelope(defaultResult);
  if (!envelope.ok) {
    return listError(envelope.msg);
  }
  const tasks = parseGrowthTasks(envelope.data, false);
  if (scope === "all") {
    try {
      const mpResult = await taskRequest(ctx, listUrl, {
        method: "GET",
        headers: { ...baseHeaders, ...mpListHeader },
      });
      const mpEnvelope = unwrapEnvelope(mpResult);
      if (mpEnvelope.ok) {
        const seen = new Set(tasks.map((task) => task.taskCode));
        for (const task of parseGrowthTasks(mpEnvelope.data, true)) {
          if (!seen.has(task.taskCode)) tasks.push(task);
        }
      }
    } catch {
      // mp 口径失败静默：默认口径已可用，mp 专属任务不出现即可
    }
  }
  return { tasks };
}

// ─── 动作的事件构造器（占位符书写，字段对齐参考实现逐字）───

const now = () => Date.now();

/** 桌面指纹公共字段（参考 desktopFingerprint；timestamp/presentAt 按构造时刻） */
function desktopFingerprint(): Record<string, unknown> {
  const at = now();
  return {
    timezone: "Asia/Shanghai",
    reportDelay: 2000,
    userId: UID_PLACEHOLDER,
    username: NICKNAME_PLACEHOLDER,
    userNickname: NICKNAME_PLACEHOLDER,
    product: "SaaS",
    releaseDate: 1789036585355,
    commit: "5f9692923c93033111c51ad7b003eb80204a9b75",
    ideName: "WorkBuddy",
    ideType: "WorkBuddy",
    ideVersion: "5.5.6",
    machineId: MACHINE_ID_PLACEHOLDER,
    sessionId: SESSION_ID_PLACEHOLDER,
    extName: "workbuddy-desktop",
    extVersion: "5.5.6",
    os: "win32",
    arch: "x64",
    osVersion: "10.0.26220",
    cpuCores: 20,
    memorySize: 24,
    timestamp: at,
    presentAt: at,
  };
}

/** mp 指纹公共字段（参考 mpEventBase；machineId 是参考写死的固定值，非 uid 派生） */
function mpFingerprint(): Record<string, unknown> {
  return {
    timestamp: now(),
    ideType: "WorkBuddy_MP",
    ideVersion: "2.4.0",
    extName: "workbuddy-mp",
    extVersion: "2.4.0",
    product: "SaaS",
    ideName: "wx_app_cloud",
    platform: "mini_program",
    os: "windows",
    osVersion: "11",
    arch: "x64",
    machineId: "0655736a-607f-4d9d-b430-58176ee9a090",
    timezone: "Asia/Shanghai",
    userId: UID_PLACEHOLDER,
    userNickname: NICKNAME_PLACEHOLDER,
  };
}

/** chat 活跃上报事件（参考 chatRequestEvent 完整形状——勿删字段，防上游加严） */
function chatRequestEvent(conversationId: string, requestId: string): Record<string, unknown> {
  return {
    eventCode: "chat_request_send",
    timestamp: now(),
    reportDelay: 0,
    mode: "craft",
    conversationId,
    requestId,
    inputLength: 12,
    requestModelId: "deepseek-v4-flash",
    requestModelName: "DeepSeek V4 Flash",
    isPlan: false,
    isAutoExecuteTerminal: false,
    isAutoModify: false,
    codebaseEnable: false,
    maxToken: 0,
    maxSteps: 0,
    temperature: 0,
    maxRetries: 0,
    mentionContexts: [],
    knowledgeId: [],
    knowledgeName: [],
    codebaseId: "",
    mentionContextCount: 0,
    command: "",
    expertId: "",
    recommendId: "",
    skillId: "",
    skillCount: 0,
    totalCount: 0,
    fileUri: "",
    presentAt: now(),
    traceId: "",
    rootRequestId: requestId,
    parentConversationId: conversationId,
    agentName: "default",
    agentType: "conversation",
    userId: UID_PLACEHOLDER,
  };
}

/** 一次「桌面端成功对话」完整事件链（参考 DesktopChatSequence，点亮 RichMeow 等） */
function desktopChatSequence(
  conversationId: string,
  requestId: string,
  messageId: string,
): Record<string, unknown>[] {
  const model = "fast-model";
  return [
    {
      eventCode: "agent_task_created",
      source: "LOCAL", name: "working", task_target: "local", mode: "craft",
      requestModelId: model, requestModelName: model,
      has_repo: false, repo_type: "none", workspace_type: "empty",
      has_connector: false, connector_types: [],
      has_mention: false, mention_types: [],
      has_template: false, action: "", template_name: "",
      has_expert: false, expert_id: "", expert_name: "", expert_industry_id: "",
      has_skill: false, skill_names: [],
      conversationId, messageId,
      buddyId: "", buddyName: "",
    },
    {
      eventCode: "chat_message_send",
      messageId: `${messageId}-assistant`, historyCount: 0,
      isContextTruncated: false, currentStepCount: 1,
      traceId: requestId, rootRequestId: requestId,
      parentConversationId: conversationId,
      agentName: "cli", agentType: "main",
    },
    {
      eventCode: "chat_request_send",
      inputLength: 24, isPlan: false, isAutoExecuteTerminal: false,
      isAutoModify: false, codebaseEnable: false, maxToken: 0,
      maxSteps: 500, temperature: 0, maxRetries: 0,
      mentionContexts: [], knowledgeId: [], knowledgeName: [],
      codebaseId: "", mentionContextCount: 0, command: "",
      recommendId: "", skillId: "", skillCount: 0, totalCount: 0,
      traceId: requestId, rootRequestId: requestId,
      parentConversationId: conversationId,
      agentName: "cli", agentType: "main",
      "codebuddy.session_id": conversationId,
      "codebuddy.conversation_request_id": requestId,
    },
    {
      eventCode: "chat_message_response",
      messageId: `${messageId}-assistant`, responseModelId: model,
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: "", finishReason: "stop",
      firstTokenAt: now(), traceId: requestId,
      conversationId,
      rootRequestId: requestId, parentConversationId: conversationId,
      agentName: "cli", agentType: "main",
      "codebuddy.session_id": conversationId,
      "codebuddy.conversation_request_id": requestId,
    },
    {
      eventCode: "chat_message_status",
      messageId: `${messageId}-assistant`, messageErrorCode: "0",
      traceId: requestId, rootRequestId: requestId,
      parentConversationId: conversationId,
      agentName: "cli", agentType: "main",
    },
    {
      eventCode: "chat_request_response",
      mode: "craft", toolCallCount: 0,
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: "", finishReason: "stop",
      rootRequestId: requestId, parentConversationId: conversationId,
    },
  ];
}

/** 「进入 Buddy 应用」五连事件（参考 DesktopBuddyAppSequence：一组覆盖
 *  Buddy_App 与 Buddy_App_QQ——载体用企鹅教师助手，后者判据应用） */
function desktopBuddyAppSequence(): Record<string, unknown>[] {
  const buddyId = "cb_y5Dy46tPQGGWtueMxXbe";
  const buddyName = "企鹅教师助手";
  const base = { mode: "LOCAL", buddyId, buddyName };
  return [
    { eventCode: "buddyapp_discover_click", ...base },
    { eventCode: "buddyapp_show", ...base, elementId: buddyId, elementName: buddyName, position: 2 },
    { eventCode: "buddyapp_enter_click", ...base, elementId: buddyId, elementName: buddyName, position: 2, isFirstPage: "1" },
    { eventCode: "buddyapp_auth_confirm_click", ...base, elementId: buddyId, elementName: buddyName },
    { eventCode: "buddyapp_bindaccount_skip_click", ...base, elementId: buddyId, elementName: buddyName },
  ];
}

/** 「使用模板创建任务」事件组（参考 DesktopTemplateUseSequence：JOIN 完整 chat 链） */
function desktopTemplateUseSequence(
  conversationId: string,
  requestId: string,
  templateId: string,
  templateName: string,
): Record<string, unknown>[] {
  return [
    ...desktopChatSequence(conversationId, requestId, `msg-${templateId}`),
    {
      eventCode: "agent_task_created_with_template", mode: "working",
      isCustomModel: false, id: templateId, name: templateName, requestId,
    },
    { eventCode: "template_used", template_id: templateId, task_mode: "working" },
  ];
}

/** 「灵感案例做同款」事件组（参考 DesktopPlaybookPromptSequence） */
function desktopPlaybookPromptSequence(
  conversationId: string,
  requestId: string,
  caseId: string,
  caseName: string,
): Record<string, unknown>[] {
  const payload = { id: caseId, name: caseName, type: "document", categoryId: "", categoryName: "" };
  return [
    ...desktopChatSequence(conversationId, requestId, "msg-pb"),
    {
      eventCode: "web_element_click", pageName: "playbook_detail",
      elementId: "playbook_ctaClick", elementName: caseName, source: "discover",
    },
    { eventCode: "playbook_cta_click", source: "discover", position: 0, ...payload },
    { eventCode: "playbook_prompt_send", conversationId, requestId, ...payload },
  ];
}

/** 「设计创意画布」事件组（参考 DesktopDesignCanvasSequence） */
function desktopDesignCanvasSequence(
  conversationId: string,
  requestId: string,
): Record<string, unknown>[] {
  return [
    ...desktopChatSequence(conversationId, requestId, "msg-canvas"),
    {
      eventCode: "wbx_design_canvas_task_create", conversationId,
      requestId, source: "summon_keyword", cost: 12000, isSuccessful: true,
    },
    {
      eventCode: "wbx_design_canvas_open", conversationId,
      requestId, id: `ardot-file-${requestId.slice(-8)}`,
      source: "summon_keyword", type: "page", cost: 13000, isSuccessful: true,
    },
  ];
}

/** mp 指纹对话事件（参考 SchoolChatTimesEvents；withActivityId 时为校园日判据） */
function mpChatEvent(conversationId: string, withActivityId: boolean): Record<string, unknown> {
  const rid = `wb2api-${Math.random().toString(36).slice(2, 14)}`;
  const event: Record<string, unknown> = {
    eventCode: "chat_request_send",
    inputLength: 14, isPlan: false, isAutoExecuteTerminal: false,
    isAutoModify: false, codebaseEnable: false, maxToken: 0,
    maxSteps: 500, temperature: 0, maxRetries: 0,
    mentionContexts: [], knowledgeId: [], knowledgeName: [],
    codebaseId: "", mentionContextCount: 0, command: "",
    recommendId: "", skillId: "", skillCount: 0, totalCount: 0,
    traceId: rid, rootRequestId: rid,
    parentConversationId: conversationId, conversationId,
    messageId: `msg-${rid.slice(-8)}`,
    agentName: "mp", agentType: "main",
    "codebuddy.session_id": conversationId,
    "codebuddy.conversation_request_id": rid,
  };
  if (withActivityId) event.activityId = "school_open_day_2026";
  return event;
}

/** mp 指纹专家使用事件（参考 MiniExpertUseEvent：不带会话字段，extVersion 覆盖为 2.2.8） */
function mpExpertUseEvent(expertId: string, expertName: string): Record<string, unknown> {
  return {
    eventCode: "expert_actual_use", reportDelay: 0,
    extVersion: "2.2.8", source: "mini_program",
    id: expertId, name: expertId,
    expertTitle: expertName, type: "send_message",
    characterCount: 12, expertType: "agent",
  };
}

// ─── 上报与领奖原语 ───

/** 事件上报域按通道分流（2026-09-26 真机修正）：token 通道走参考项目实证的组合
 *  （桌面/web 事件 → copilot / workbuddy.cn，Bearer），Cookie 通道统走 spike 实证
 *  的 codebuddy.cn/v2/report + web 头族——copilot 的 report 不认 Cookie 会话
 *  （真机 401，参考项目与 spike 都只证过各自通道），而 codebuddy 的 report 端点
 *  Cookie 会话计分已实证（chat_5 0/5→1/5）。计分判据在事件体指纹字段，不在域 */
function reportTarget(ctx: TaskContext): { url: string; headers: Record<string, string> } {
  if (ctx.channel === "cookie") {
    return {
      url: `${BILLING_ORIGIN}/v2/report`,
      headers: {
        ...chatReportHeadersCookie,
        ...(ctx.account?.uid ? { "X-User-Id": ctx.account.uid } : {}),
      },
    };
  }
  return { url: `${GROWTH_ORIGIN}/v2/report`, headers: desktopReportHeaders };
}

/** 桌面指纹事件上报（域与头族按通道分流，见 reportTarget；token 通道 Rust 注入
 *  桌面 UA 与占位符） */
async function reportDesktopEvents(
  ctx: TaskContext,
  events: Record<string, unknown>[],
): Promise<void> {
  const merged = events.map((event) => ({ ...desktopFingerprint(), ...event }));
  const target = reportTarget(ctx);
  const result = await invoke<HttpResult>("provider_request", {
    instanceId: ctx.instance.id,
    url: target.url,
    method: "POST",
    auth: reportAuthFor(ctx),
    headers: target.headers,
    bodyText:
      ctx.channel === "cookie" && ctx.account
        ? await fillPlaceholders(JSON.stringify(merged), ctx.account)
        : JSON.stringify(merged),
  });
  const envelope = unwrapEnvelope(result);
  if (!envelope.ok) throw envelopeError("事件上报失败：{detail}", envelope.msg);
}

/** chat 活跃上报（billing 域 /v2/report，chat_5 计数与领养前置） */
async function reportChatActivity(ctx: TaskContext, conversationId: string): Promise<void> {
  const event = chatRequestEvent(conversationId, conversationId);
  const headers =
    ctx.channel === "cookie" ? chatReportHeadersCookie : chatReportHeadersToken;
  const raw = JSON.stringify([event]);
  const result = await invoke<HttpResult>("provider_request", {
    instanceId: ctx.instance.id,
    url: `${BILLING_ORIGIN}/v2/report`,
    method: "POST",
    auth: reportAuthFor(ctx),
    headers,
    bodyText:
      ctx.channel === "cookie" && ctx.account
        ? await fillPlaceholders(raw, ctx.account)
        : raw,
  });
  const envelope = unwrapEnvelope(result);
  if (!envelope.ok) throw envelopeError("活跃上报失败：{detail}", envelope.msg);
}

/** web 域事件上报（Library_read 判据；域与头族按通道分流，见 reportTarget——
 *  workbuddy.cn/v2/report 的 Cookie 组合未验证，Cookie 通道统走实证的 codebuddy 域） */
async function reportWebEvent(
  ctx: TaskContext,
  eventCode: string,
  pageUrl: string,
  elementId: string,
  elementName: string,
): Promise<void> {
  const event = {
    eventCode,
    timestamp: now(),
    reportDelay: 0,
    pageURL: pageUrl,
    elementId,
    elementName,
    os: "Win32",
    arch: "",
    osVersion: "10.0",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    machineId: WEB_MACHINE_ID_PLACEHOLDER,
    userId: UID_PLACEHOLDER,
    userNickname: NICKNAME_PLACEHOLDER,
    enterpriseId: "",
  };
  const raw = JSON.stringify([event]);
  const target = reportTarget(ctx);
  const headers =
    ctx.channel === "cookie"
      ? target.headers
      : {
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-client-platform": "web",
          Origin: WEB_ORIGIN,
          Referer: pageUrl,
        };
  const result = await invoke<HttpResult>("provider_request", {
    instanceId: ctx.instance.id,
    url: target.url,
    method: "POST",
    auth: reportAuthFor(ctx),
    headers,
    bodyText:
      ctx.channel === "cookie" && ctx.account
        ? await fillPlaceholders(raw, ctx.account)
        : raw,
  });
  const envelope = unwrapEnvelope(result);
  if (!envelope.ok) throw envelopeError("事件上报失败：{detail}", envelope.msg);
}

/** mp 指纹事件上报（codebuddy.cn /v2/report） */
async function reportMpEvents(
  ctx: TaskContext,
  events: Record<string, unknown>[],
): Promise<void> {
  const merged = events.map((event) => ({ ...mpFingerprint(), ...event }));
  const raw = JSON.stringify(merged);
  const result = await invoke<HttpResult>("provider_request", {
    instanceId: ctx.instance.id,
    url: `${BILLING_ORIGIN}/v2/report`,
    method: "POST",
    auth: reportAuthFor(ctx),
    headers: mpReportHeaders,
    bodyText:
      ctx.channel === "cookie" && ctx.account
        ? await fillPlaceholders(raw, ctx.account)
        : raw,
  });
  const envelope = unwrapEnvelope(result);
  if (!envelope.ok) throw envelopeError("事件上报失败：{detail}", envelope.msg);
}

/** 领奖结果：credit/energy 为本次到账（已领取过时双零，不算错） */
export interface ClaimOutcome {
  credit: number;
  energy: number;
  alreadyClaimed: boolean;
}

/** 解析领奖响应 data：{already_claimed, credit, energy} */
export function parseClaimReward(data: unknown): ClaimOutcome {
  const payload = (data ?? {}) as {
    already_claimed?: boolean;
    credit?: number;
    energy?: number;
  };
  return {
    credit: payload.credit ?? 0,
    energy: payload.energy ?? 0,
    alreadyClaimed: Boolean(payload.already_claimed),
  };
}

/** web 域领奖（默认口径；幂等——already_claimed 双零不算错。两通道同头族：Origin/
 *  Referer/x-client-platform: web 是协议头非凭据头，token 通道照带，参考 ClaimReward
 *  的 Bearer + web 头组合同款） */
async function claimOnWeb(ctx: TaskContext, taskCode: string): Promise<ClaimOutcome> {
  const result = await invoke<HttpResult>("provider_request", {
    instanceId: ctx.instance.id,
    url: `${WEB_ORIGIN}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`,
    method: "POST",
    auth: authFor(ctx),
    headers: claimHeadersWeb,
  });
  const envelope = unwrapEnvelope(result);
  if (!envelope.ok) throw envelopeError("领奖失败：{detail}", envelope.msg);
  return parseClaimReward(envelope.data);
}

/** 领奖：mp 任务先走 copilot 域 + miniprogram 头（token 通道），HTTP 400（部分
 *  任务/租户形态）或传输层失败时降级 web 域（参考 ClaimRewardMP 同款降级）；默认
 *  口径直接 web 域。Cookie 通道跳过 copilot 首选（POST 拒 Cookie，真机 401）直接
 *  走 web 域 claim（spike 已证 Cookie 领奖）。信封失败直接抛、不重复降级 */
async function claimReward(ctx: TaskContext, task: WorkbuddyTask): Promise<ClaimOutcome> {
  if (!task.isMp || ctx.channel === "cookie") return claimOnWeb(ctx, task.taskCode);
  let result: HttpResult;
  try {
    result = await taskRequest(ctx, `${GROWTH_ORIGIN}/activity/growth/tasks/${encodeURIComponent(task.taskCode)}/claim`, {
      method: "POST",
      headers: { ...taskHeadersToken, ...mpListHeader },
    });
  } catch (error) {
    // copilot 域传输层失败 → 降级 web 域试一次（两条路径参考实现都在线运行）
    void error;
    return claimOnWeb(ctx, task.taskCode);
  }
  if (result.status === 400) return claimOnWeb(ctx, task.taskCode);
  const envelope = unwrapEnvelope(result);
  if (!envelope.ok) throw envelopeError("领奖失败：{detail}", envelope.msg);
  return parseClaimReward(envelope.data);
}

// ─── 动作表（15 项，顺序即依赖序：领养链前置上报在前）───

export interface TaskActionRunResult {
  message: string;
  params?: Record<string, string | number>;
}

interface TaskAction {
  taskCode: string;
  /** 面板兜底标题（上游 title 优先） */
  fallbackTitle: string;
  mp?: boolean;
  run: (ctx: TaskContext) => Promise<TaskActionRunResult>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** 连续上报之间的节流（参考 reportGap 1050ms 风控口径） */
const REPORT_GAP_MS = 1050;

/** 生成一次性会话标识（参考实现 wb2api-<ms> 前缀语义，服务端不校验一致性） */
const freshId = (prefix: string) => `${prefix}-${now()}-${Math.floor(Math.random() * 1e4)}`;

/** 模板任务的五组载体（template_id 服务端不校验真实性，参考实测） */
const TEMPLATE_PAYLOADS: [string, string][] = [
  ["1", "深度研究"],
  ["2", "周报生成"],
  ["3", "竞品分析"],
  ["4", "活动策划"],
  ["5", "代码评审"],
];

/** Hp_Appearance 判据主题（参考实测：和平精英激战金秋；会真实切换账号主题） */
const APPEARANCE_THEME_KEY = "theme-tkmw7j";

/** growth 域写动作的基址按通道分流（2026-09-26 真机二次修正）：copilot 对 POST 一律
 *  要求 Bearer（Cookie accept 真机 401，www-authenticate: Bearer realm="copilot"），而
 *  workbuddy.cn 的同族 POST（无 /v2）与日常 travel/streak/claim 同形态、Cookie 日常在跑
 *  （签到/report 也是 Cookie POST 已证）——Cookie 通道写动作统走 workbuddy.cn，token
 *  通道保持 copilot + Bearer（参考项目实证）。列表 GET 例外：copilot + Cookie 已真机
 *  证出数（spike 与日常使用），保持不动 */
function growthBase(ctx: TaskContext): string {
  return ctx.channel === "cookie" ? WEB_ORIGIN : GROWTH_ORIGIN;
}

export const TASK_ACTIONS: TaskAction[] = [
  {
    taskCode: "chat_5",
    fallbackTitle: "完成 5 次对话",
    run: async (ctx) => {
      for (let index = 0; index < 5; index += 1) {
        await reportChatActivity(ctx, freshId("wb2api-chat5"));
        if (index < 4) await sleep(REPORT_GAP_MS);
      }
      return { message: "已上报 5 条对话活跃事件" };
    },
  },
  {
    taskCode: "first_buddy",
    fallbackTitle: "领养第一只喵喵",
    run: async (ctx) => {
      // 前置活跃上报（领养门槛）→ 同意协议（幂等）→ 领取；写动作基址按通道分流（growthBase）
      await reportChatActivity(ctx, freshId("wb2api-adopt"));
      await sleep(REPORT_GAP_MS);
      const base = growthBase(ctx);
      const baseHeaders = ctx.channel === "cookie" ? taskHeadersCookie : taskHeadersToken;
      const agreement = await taskRequest(ctx, `${base}/activity/growth/buddy/agreement`, {
        method: "POST",
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        bodyText: JSON.stringify({ agree: true }),
      });
      if (!unwrapEnvelope(agreement).ok) throw new TaskActionError("同意协议失败");
      const first = await taskRequest(ctx, `${base}/activity/growth/buddy/first`, {
        method: "POST",
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        bodyText: "{}",
      });
      const envelope = unwrapEnvelope(first);
      if (!envelope.ok) {
        if (envelope.msg.includes("first_buddy")) {
          throw new TaskActionError("领养门槛未过（服务端要求当日活跃），稍后重试");
        }
        throw envelopeError("领取 Buddy 失败：{detail}", envelope.msg);
      }
      return { message: "已领养 Buddy" };
    },
  },
  {
    taskCode: "RichMeow_Chat",
    fallbackTitle: "完成一次桌面对话",
    run: async (ctx) => {
      const conversationId = freshId("wb2api-rm");
      await reportDesktopEvents(ctx, desktopChatSequence(conversationId, `${conversationId}-req`, "req-user"));
      return { message: "已上报桌面对话事件" };
    },
  },
  {
    taskCode: "Buddy_App",
    fallbackTitle: "进入 Buddy 应用",
    run: async (ctx) => {
      await reportDesktopEvents(ctx, desktopBuddyAppSequence());
      return { message: "已上报进入 Buddy 应用事件链" };
    },
  },
  {
    taskCode: "Buddy_App_QQ",
    fallbackTitle: "进入企鹅教师助手",
    run: async (ctx) => {
      // 与 Buddy_App 共用一组事件（参考实现同款：一组同时满足两项判据）
      await reportDesktopEvents(ctx, desktopBuddyAppSequence());
      return { message: "已上报进入应用事件链" };
    },
  },
  {
    taskCode: "automation_1",
    fallbackTitle: "设置自动化任务",
    run: async (ctx) => {
      await reportDesktopEvents(ctx, [{
        eventCode: "automated_task_create_suc",
        name: "自动化任务",
        source: "manually", modelId: "fast-model", modelIsThinking: true,
        connectorCount: 0, skills: "", skillCount: 0,
        scheduleType: "once", mode: "LOCAL",
      }]);
      return { message: "已上报定时任务创建事件" };
    },
  },
  {
    taskCode: "Library_read",
    fallbackTitle: "阅读资料库介绍",
    run: async (ctx) => {
      await reportWebEvent(
        ctx,
        "web_element_click",
        "https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm",
        "library_doc_intro_click",
        "WorkBuddy资料库介绍",
      );
      return { message: "已上报资料库阅读事件" };
    },
  },
  {
    taskCode: "template_5",
    fallbackTitle: "使用模板创建任务 ×5",
    run: async (ctx) => {
      for (let index = 0; index < TEMPLATE_PAYLOADS.length; index += 1) {
        const [templateId, templateName] = TEMPLATE_PAYLOADS[index];
        const conversationId = freshId("wb2api-tpl");
        await reportDesktopEvents(ctx, desktopTemplateUseSequence(conversationId, `${conversationId}-req`, templateId, templateName));
        if (index < TEMPLATE_PAYLOADS.length - 1) await sleep(300);
      }
      return { message: "已上报模板使用事件 ×5" };
    },
  },
  {
    taskCode: "playbook_prompt",
    fallbackTitle: "用灵感案例发送 Prompt",
    run: async (ctx) => {
      const conversationId = freshId("wb2api-pb");
      await reportDesktopEvents(ctx, desktopPlaybookPromptSequence(conversationId, `${conversationId}-req`, "pm-gtm-launch-plan", "新产品上市 GTM 发布计划一页纸"));
      return { message: "已上报灵感案例发送事件" };
    },
  },
  {
    taskCode: "create_canvas",
    fallbackTitle: "创建设计画布",
    run: async (ctx) => {
      const conversationId = freshId("wb2api-canvas");
      await reportDesktopEvents(ctx, desktopDesignCanvasSequence(conversationId, `${conversationId}-req`));
      return { message: "已上报画布创建事件" };
    },
  },
  {
    taskCode: "Hp_Appearance",
    fallbackTitle: "更换主题外观",
    run: async (ctx) => {
      // 先真实切换账号主题（副作用：客户端主题被切换，可手动换回），再上报皮肤生效事件。
      // set 基址按通道分流（growthBase）：copilot /v2 形态给 token 通道，Cookie 走
      // workbuddy.cn 同路径（探测存在；copilot 拒 Cookie POST）
      const setResult = await invoke<HttpResult>("provider_request", {
        instanceId: ctx.instance.id,
        url: `${growthBase(ctx)}/v2/user-asset/appearance/set`,
        method: "POST",
        auth: reportAuthFor(ctx),
        headers: reportTarget(ctx).headers,
        bodyText: JSON.stringify({ kind: "theme", resource_key: APPEARANCE_THEME_KEY }),
      });
      if (!unwrapEnvelope(setResult).ok) throw new TaskActionError("主题设置失败");
      await sleep(2_000);
      await reportDesktopEvents(ctx, [{
        eventCode: "appearance_skin_apply",
        action: "apply", source: "settings_close",
        id: APPEARANCE_THEME_KEY, vipLevel: 0, series: "", type: "unknown",
      }]);
      return { message: "已切换主题并上报生效事件" };
    },
  },
  {
    taskCode: "school_season",
    fallbackTitle: "校园日小程序对话",
    mp: true,
    run: async (ctx) => {
      await reportMpEvents(ctx, [mpChatEvent(freshId("wb2api-mp"), true)]);
      return { message: "已上报校园日对话事件" };
    },
  },
  {
    taskCode: "Sequential_Tasks_1",
    fallbackTitle: "小程序首次对话",
    mp: true,
    run: async (ctx) => {
      await reportMpEvents(ctx, [mpChatEvent(freshId("wb2api-mp"), false)]);
      return { message: "已上报小程序对话事件" };
    },
  },
  {
    taskCode: "Sequential_Tasks_2",
    fallbackTitle: "小程序选专家对话",
    mp: true,
    run: async (ctx) => {
      // 专家 id 必须是市场真实 ex_ id（编造不入账）：先拉市场列表取第一位。
      // 基址按通道分流（growthBase，copilot 拒 Cookie POST）
      const baseHeaders = ctx.channel === "cookie" ? taskHeadersCookie : taskHeadersToken;
      const listResult = await taskRequest(ctx, `${growthBase(ctx)}/portal/operation-platform/market/expert/list`, {
        method: "POST",
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        bodyText: JSON.stringify({ page: 1, page_size: 20, sort_by: "reco_rank", sort_order: "desc" }),
      });
      const envelope = unwrapEnvelope(listResult);
      if (!envelope.ok) throw new TaskActionError("专家市场列表获取失败");
      const experts = (envelope.data as { experts?: { expert_id?: string; display_name_zh?: string; profession_zh?: string }[] } | undefined)?.experts ?? [];
      const expert = experts.find((item) => item.expert_id);
      if (!expert) throw new TaskActionError("专家市场列表为空");
      const name = expert.display_name_zh || expert.profession_zh || expert.expert_id || "";
      await reportMpEvents(ctx, [mpExpertUseEvent(expert.expert_id!, name)]);
      return { message: "已上报专家使用事件（{name}）", params: { name } };
    },
  },
  {
    taskCode: "Sequential_Tasks_3",
    fallbackTitle: "小程序完成 5 次对话",
    mp: true,
    run: async (ctx) => {
      for (let index = 0; index < 5; index += 1) {
        await reportMpEvents(ctx, [mpChatEvent(freshId("wb2api-mp"), false)]);
        if (index < 4) await sleep(2_000);
      }
      return { message: "已上报小程序对话事件 ×5" };
    },
  },
];

/** 自动执行码集合（动作表全集） */
export const AUTOMATABLE_CODES = new Set(TASK_ACTIONS.map((action) => action.taskCode));
/** 动作码 → 动作（依赖序即表序） */
const ACTION_BY_CODE = new Map(TASK_ACTIONS.map((action) => [action.taskCode, action]));

// ─── 面板分层（ADR-0036 展示口径：可自动完成 / 可领取 / 已完成；未知码不显示）───

export interface TaskLayers {
  automatable: WorkbuddyTask[];
  claimable: WorkbuddyTask[];
  done: WorkbuddyTask[];
}

const KNOWN_CODES = new Set([...AUTOMATABLE_CODES, ...CLAIMABLE_ONLY_CODES]);

/** 把合并后的任务列表分进三层展示：
 *  - 可自动完成：动作表码且未领未锁未达标（locked 不显示——Sequential 链每日解锁，
 *    未解锁的扫进来只会 accept 不落账报失败）
 *  - 可领取：已知码且达标未领（含真实对话类——只开放代领，不出现执行按钮）
 *  - 已完成：已知码且已领取
 *  达标判定在此自行推算（!claimed && target>0 && current>=target），不信任调用方
 *  填的 claimable——分层是纯函数，输入只认服务端四事实（claimed/target/current/locked） */
export function layerTasks(tasks: WorkbuddyTask[]): TaskLayers {
  const automatable: WorkbuddyTask[] = [];
  const claimable: WorkbuddyTask[] = [];
  const done: WorkbuddyTask[] = [];
  for (const task of tasks) {
    if (!KNOWN_CODES.has(task.taskCode)) continue;
    if (task.claimed) {
      done.push(task);
    } else if (task.target > 0 && task.current >= task.target) {
      claimable.push(task);
    } else if (AUTOMATABLE_CODES.has(task.taskCode) && !task.locked) {
      automatable.push(task);
    }
  }
  // 可自动完成按动作表依赖序排（领养链前置在前），其余按上游下发序
  const actionIndex = (code: string) => TASK_ACTIONS.findIndex((a) => a.taskCode === code);
  automatable.sort((a, b) => actionIndex(a.taskCode) - actionIndex(b.taskCode));
  return { automatable, claimable, done };
}

// ─── 执行引擎 ───

/** 任务动作错误：message 是中文模板（i18n 中文即 key），params 由渲染层 applyParams
 *  替换（上游 msg 等动态原文走 {detail}，不做翻译） */
export class TaskActionError extends Error {
  params?: Record<string, string | number>;
  constructor(template: string, params?: Record<string, string | number>) {
    super(template);
    this.params = params;
  }
}

/** 上游信封失败 → 标准动作错误：固定中文模板包住上游原文（{detail} 不翻译） */
const envelopeError = (fallback: string, msg: string) =>
  new TaskActionError(fallback, msg ? { detail: msg } : undefined);

/** 单项动作结果（面板行内反馈）：message 是中文模板，与 params 一起由渲染层
 *  renderTemplate 出文案（{message} 位置的嵌套模板也会被翻译） */
export interface WorkbuddyTaskRunResult {
  taskCode: string;
  ok: boolean;
  message: string;
  params?: Record<string, string | number>;
  credit: number;
  energy: number;
}

/** default 口径任务的接受（执行前置，尽力而为）：上游对 not_accepted 的任务不计数
 *  （参考 taskcenter.go 队列前置 acceptPendingTasks——漏了这步的表现是上报 200 但
 *  进度不动、无法领奖）。端点与通道分流同 acceptMpTask（token → copilot /v2，
 *  Cookie → workbuddy.cn 无 /v2，copilot 拒 Cookie POST），但头族是 web/token 标准
 *  形态（非 miniprogram 口径，参考 AcceptTasks 用 growthJSON 标准头）。失败返回
 *  false 不阻塞：部分任务本就无需接受，凭据失效会在随后的动作/回读里显性暴露 */
async function acceptDefaultTask(ctx: TaskContext, taskCode: string): Promise<boolean> {
  const baseHeaders = ctx.channel === "cookie" ? taskHeadersCookie : taskHeadersToken;
  const acceptUrl =
    ctx.channel === "cookie"
      ? `${WEB_ORIGIN}/activity/growth/tasks/accept`
      : `${GROWTH_ORIGIN}/v2/activity/growth/tasks/accept`;
  const result = await taskRequest(ctx, acceptUrl, {
    method: "POST",
    headers: { ...baseHeaders, "Content-Type": "application/json" },
    bodyText: JSON.stringify({ task_codes: [taskCode] }),
  });
  if (result.status !== 200) return false;
  return unwrapEnvelope(result).ok;
}

/** mp 任务接受（带登记回读验证——上游存在 200 OK 但未落账形态，此时上报不归账）。
 *  accept 基址按通道分流：token 走 copilot /v2（参考实证），Cookie 走 workbuddy.cn
 *  无 /v2（与 travel/depart 同形态；copilot 拒 Cookie POST 真机 401）。回读列表恒
 *  copilot GET（Cookie 通道已真机证出数）。HTTP 401/403 是凭据失效，直接抛凭据
 *  文案——与「每日锁定窗口」（业务成功但回读未登记）是两回事，不能混同误导 */
async function acceptMpTask(ctx: TaskContext, taskCode: string): Promise<boolean> {
  const baseHeaders = ctx.channel === "cookie" ? taskHeadersCookie : taskHeadersToken;
  const acceptUrl =
    ctx.channel === "cookie"
      ? `${WEB_ORIGIN}/activity/growth/tasks/accept`
      : `${GROWTH_ORIGIN}/v2/activity/growth/tasks/accept`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const acceptResult = await taskRequest(ctx, acceptUrl, {
      method: "POST",
      headers: { ...baseHeaders, "Content-Type": "application/json", ...mpListHeader },
      bodyText: JSON.stringify({ task_codes: [taskCode] }),
    });
    if (acceptResult.status === 401 || acceptResult.status === 403) {
      throw new TaskActionError("任务接受失败（HTTP {status}），请刷新登录状态后重试", {
        status: acceptResult.status,
      });
    }
    if (unwrapEnvelope(acceptResult).ok) {
      await sleep(2_000);
      const listResult = await taskRequest(ctx, `${GROWTH_ORIGIN}/v2/activity/growth/tasks`, {
        method: "GET",
        headers: { ...baseHeaders, ...mpListHeader },
      });
      const envelope = unwrapEnvelope(listResult);
      if (envelope.ok) {
        const found = parseGrowthTasks(envelope.data, true).find((task) => task.taskCode === taskCode);
        if (found && found.acceptStatus !== "not_accepted" && found.acceptStatus !== "") return true;
      }
    }
  }
  return false;
}

/** 回读定位单个任务（按 isMp 只拉单口径：回读不需要双口径合并，一轮执行的总
 *  列表 GET 从全量双口径的 120+ 收敛回几十） */
async function findTask(
  ctx: TaskContext,
  taskCode: string,
  isMp: boolean,
): Promise<WorkbuddyTask | null> {
  const { tasks } = await fetchWorkbuddyTasks(ctx, isMp ? "mp" : "default");
  return tasks.find((task) => task.taskCode === taskCode) ?? null;
}

/** 有界轮询回读（服务端异步计分，参考实测 5~8 秒落账）：达标即返，预算耗尽返最后一次 */
async function findTaskWaiting(
  ctx: TaskContext,
  taskCode: string,
  isMp: boolean,
): Promise<WorkbuddyTask | null> {
  let task = await findTask(ctx, taskCode, isMp);
  for (let attempt = 0; attempt < 3 && task && !task.claimable && !task.claimed; attempt += 1) {
    await sleep(3_000);
    const next = await findTask(ctx, taskCode, isMp);
    if (next) task = next;
  }
  return task;
}

/** 执行单个自动任务：前置读 →（mp 先 accept 带验证）→ 动作上报 → 回读轮询 → 达标自动领奖。
 *  返回的 message 是中文模板（可能含 {message} 嵌套——动作消息作为参数值再翻译），
 *  params 由渲染层 renderTemplate 替换。**params 的键序必须是 message 在前**：
 *  applyParams 按 entries 插入序单遍替换，message 值里含的 {name} 等占位符依赖
 *  其后的参数条目替换——倒序会把字面 {name} 漏给用户 */
export async function runWorkbuddyTask(
  ctx: TaskContext,
  task: WorkbuddyTask,
): Promise<WorkbuddyTaskRunResult> {
  const action = ACTION_BY_CODE.get(task.taskCode);
  if (!action) {
    return { taskCode: task.taskCode, ok: false, message: "该任务不支持自动完成", credit: 0, energy: 0 };
  }
  if (action.mp) {
    const current = (await findTask(ctx, task.taskCode, task.isMp)) ?? task;
    if (current.acceptStatus === "not_accepted" || current.acceptStatus === "") {
      const accepted = await acceptMpTask(ctx, task.taskCode);
      if (!accepted) {
        return {
          taskCode: task.taskCode,
          ok: false,
          message: "任务接受未生效（可能处于每日锁定窗口），稍后重试",
          credit: 0,
          energy: 0,
        };
      }
    }
  } else if (
    !task.claimed &&
    !task.locked &&
    (task.acceptStatus === "not_accepted" || task.acceptStatus === "")
  ) {
    // default 口径：接受后才计分，执行前尽力补报（同参考队列前置语义）。快照即
    // 面板拉取时的状态——accept 只有本执行链会推进，不值得为此再拉一次列表；
    // 接受成功稍候再上报，给上游状态流转留时间
    if (await acceptDefaultTask(ctx, task.taskCode)) await sleep(REPORT_GAP_MS);
  }
  const { message, params } = await action.run(ctx);
  const after = await findTaskWaiting(ctx, task.taskCode, task.isMp);
  if (after?.claimable) {
    const outcome = await claimReward(ctx, after);
    const flat = { message, ...params, credit: outcome.credit, energy: outcome.energy };
    if (outcome.alreadyClaimed || (outcome.credit === 0 && outcome.energy === 0)) {
      return { taskCode: task.taskCode, ok: true, message: "{message}；奖励此前已领取", params: flat, credit: 0, energy: 0 };
    }
    return {
      taskCode: task.taskCode,
      ok: true,
      message: outcome.energy > 0
        ? "{message}；已自动领取 +{credit} 分 +{energy} 能量"
        : "{message}；已自动领取 +{credit} 分",
      params: flat,
      credit: outcome.credit,
      energy: outcome.energy,
    };
  }
  if (after?.claimed) {
    return { taskCode: task.taskCode, ok: true, message: "{message}；已领取", params: { message, ...params }, credit: 0, energy: 0 };
  }
  return {
    taskCode: task.taskCode,
    ok: true,
    message: "{message}（进度未即时归账，稍后刷新查看）",
    params: { message, ...params },
    credit: 0,
    energy: 0,
  };
}

/** 领取「可领取」层的任务（真实对话类达标未领的代领入口，幂等） */
export async function claimWorkbuddyTask(
  ctx: TaskContext,
  task: WorkbuddyTask,
): Promise<WorkbuddyTaskRunResult> {
  const outcome = await claimReward(ctx, task);
  if (outcome.alreadyClaimed || (outcome.credit === 0 && outcome.energy === 0)) {
    return { taskCode: task.taskCode, ok: true, message: "奖励此前已领取", credit: 0, energy: 0 };
  }
  return {
    taskCode: task.taskCode,
    ok: true,
    message: outcome.energy > 0 ? "已领取 +{credit} 分 +{energy} 能量" : "已领取 +{credit} 分",
    params: { credit: outcome.credit, energy: outcome.energy },
    credit: outcome.credit,
    energy: outcome.energy,
  };
}
