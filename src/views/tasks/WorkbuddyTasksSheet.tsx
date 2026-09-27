import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Gift,
  ListChecks,
  LoaderCircle,
  Lock,
  RefreshCw,
  Sparkles,
  Zap,
} from "lucide-react";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { IconButton } from "../../components/ui/icon-button";
import { EmptyState } from "../../components/ui/empty-state";
import { Progress } from "../../components/ui/progress";
import { SiteBadge } from "../../components/SiteBadge";
import { TASKS_OPENED_EVENT, tasksOpenedKey } from "../../components/ProviderCard";
import { renderTemplate, useT } from "../../i18n";
import { displayName } from "../../lib/instance";
import { providerName } from "../../providers";
import { cstDateString, workbuddySiteOf, workbuddyApi } from "../../providers/workbuddy";
import {
  TASK_ACTIONS,
  claimWorkbuddyTask,
  createTaskContext,
  fetchWorkbuddyTasks,
  layerTasks,
  TaskActionError,
  type WorkbuddyTask,
} from "../../providers/workbuddy-tasks";
import {
  createGrowthContext,
  fetchLotterySummaryForDisplay,
  fetchStreakFull,
  redeemSingleTier,
  runGrowthButler,
  tierStatus,
  type GrowthButlerOutcome,
  type GrowthContext,
} from "../../providers/workbuddy-growth";
import { nextTierGap, type WorkbuddyStreakFullData } from "../../providers/workbuddy-channel";
import {
  taskDisplayTitle,
  useWorkbuddyTaskStore,
} from "../../store/workbuddyTaskStore";
import type { ProviderInstance } from "../../types/ipc";
import { cn } from "../../lib/utils";

/** 动作表兜底标题（上游 title 优先） */
const FALLBACK_TITLES = new Map(
  TASK_ACTIONS.map((action) => [action.taskCode, action.fallbackTitle]),
);

type Phase = "loading" | "ready" | "error";

/** 行内反馈（执行会话条目或领取失败的统一形状） */
interface RowFeedback {
  status: string;
  message: string;
  params?: Record<string, string | number>;
}

/** 成长任务抽屉（ADR-0036）：三层展示（可自动完成 / 可领取 / 已完成折叠），
 *  执行走 workbuddyTaskStore——关闭抽屉不中止执行，重开可见结果 */
export function WorkbuddyTasksSheet({
  instance,
  open,
  onOpenChange,
}: {
  instance: ProviderInstance | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  // t 存 ref：reload 不依赖 t 引用，语言切换不触发重拉/清会话
  const tRef = useRef(t);
  tRef.current = t;
  const [phase, setPhase] = useState<Phase>("loading");
  const [tasks, setTasks] = useState<WorkbuddyTask[] | null>(null);
  const [error, setError] = useState("");
  const [claiming, setClaiming] = useState<string[]>([]);
  /** 领取动作的行内反馈（成功与失败同形：done 显示到账文案，error 显示原因） */
  const [claimFeedback, setClaimFeedback] = useState<Record<string, RowFeedback>>({});
  const [doneExpanded, setDoneExpanded] = useState(false);
  const run = useWorkbuddyTaskStore((state) => (instance ? state.runs[instance.id] : undefined));
  const startRun = useWorkbuddyTaskStore((state) => state.startRun);
  const setPendingBadge = useWorkbuddyTaskStore((state) => state.setPendingBadge);
  const resetRun = useWorkbuddyTaskStore((state) => state.resetRun);
  const clearRunItem = useWorkbuddyTaskStore((state) => state.clearRunItem);

  // ─── 连登区块（ADR-0037）：宽松上下文（不需要 uid）、独立的拉取与领取执行态 ───
  const [growthCtx, setGrowthCtx] = useState<GrowthContext | null>(null);
  const [streakFull, setStreakFull] = useState<WorkbuddyStreakFullData | null>(null);
  const [streakFailed, setStreakFailed] = useState(false);
  const [lotteryChances, setLotteryChances] = useState<number | null>(null);
  const [butlerRunning, setButlerRunning] = useState(false);
  const [butlerRecord, setButlerRecord] = useState<GrowthButlerOutcome | undefined>(undefined);
  const [tierBusy, setTierBusy] = useState<string | null>(null);
  const [tierError, setTierError] = useState<string | undefined>(undefined);

  /** 拉连登完整状态与抽奖次数（区块数据；失败静默标记，区块给失败文案） */
  const reloadStreak = useCallback(async (ctx: GrowthContext | null) => {
    if (!ctx) return;
    setStreakFailed(false);
    const [full, summary] = await Promise.all([
      fetchStreakFull(ctx),
      fetchLotterySummaryForDisplay(ctx),
    ]);
    setStreakFull(full);
    setStreakFailed(full === null);
    setLotteryChances(summary?.chances ?? null);
  }, []);

  useEffect(() => {
    if (open && instance) {
      // 连登上下文独立于任务上下文（不需要 uid；console/account 失败不影响连登）
      void createGrowthContext(instance)
        .then((ctx) => {
          setGrowthCtx(ctx);
          return reloadStreak(ctx);
        })
        .catch(() => {
          setStreakFailed(true);
        });
    } else {
      setGrowthCtx(null);
      setStreakFull(null);
      setButlerRecord(undefined);
      setLotteryChances(null);
      setTierError(undefined);
    }
  }, [open, instance, reloadStreak]);

  /** 立即运行管家（手动补跑，幂等）：结果写行内记录并回读刷新连登区块。
   *  手动跑不发系统通知——用户主动触发的结果在行内即时可见（ADR-0037） */
  const runButler = async () => {
    if (!growthCtx || butlerRunning) return;
    setButlerRunning(true);
    setTierError(undefined);
    try {
      const outcome = await runGrowthButler(growthCtx, cstDateString(), streakFull);
      if (outcome) setButlerRecord(outcome);
      if (outcome?.streakFull) {
        setStreakFull(outcome.streakFull);
        setStreakFailed(false);
      }
      const summary = await fetchLotterySummaryForDisplay(growthCtx);
      setLotteryChances(summary?.chances ?? null);
    } finally {
      setButlerRunning(false);
    }
  };

  /** 单档兑换（档位胶囊「可兑换」点击）：行内反馈 + 回读刷新档位状态 */
  const redeemTierOne = async (tier: string) => {
    if (!growthCtx || tierBusy) return;
    setTierBusy(tier);
    setTierError(undefined);
    try {
      const outcome = await redeemSingleTier(growthCtx, tier);
      if (outcome === "redeemed") {
        const full = await fetchStreakFull(growthCtx);
        if (full) setStreakFull(full);
      } else if (outcome === "locked") {
        setTierError(t("该档位尚未解锁，连登天数以官网为准"));
      } else {
        setTierError(t("兑换失败，请稍后重试"));
      }
    } catch {
      setTierError(t("兑换失败，请稍后重试"));
    } finally {
      setTierBusy(null);
    }
  };

  /** 拉取任务列表。reset 仅手动刷新（清执行会话）；silent 供行内动作收尾的
   *  后台重扫——不进 loading 态（刚出现的行内反馈不被闪烁抹掉），失败也保持
   *  旧数据不整屏翻错误 */
  const reload = useCallback(
    async (opts?: { reset?: boolean; silent?: boolean }) => {
      if (!instance) return;
      const tt = tRef.current;
      if (!opts?.silent) setPhase("loading");
      try {
        const context = await createTaskContext(instance);
        if (!context) {
          if (opts?.silent) return;
          setPhase("error");
          setError(renderTemplate(tt("账号信息获取失败，请检查登录状态后重试"), undefined, tt));
          return;
        }
        const { tasks: fetched, error: fetchError, errorParams: fetchErrorParams } =
          await fetchWorkbuddyTasks(context);
        if (fetchError) {
          if (opts?.silent) return;
          setPhase("error");
          setError(renderTemplate(fetchError, fetchErrorParams, tt));
          return;
        }
        setTasks(fetched);
        setPhase("ready");
        if (opts?.reset) resetRun(instance.id);
        const layers = layerTasks(fetched);
        setPendingBadge(instance.id, layers.automatable.length + layers.claimable.length);
      } catch (error) {
        // 传输层失败（DNS/超时等）：silent 保持旧数据；否则进错误态给「重试」。
        // detail 透传真实原因（与 store 侧做法一致），不写死笼统文案
        if (opts?.silent) return;
        setPhase("error");
        setError(
          renderTemplate(
            tt("任务列表获取失败：{detail}"),
            { detail: error instanceof Error ? error.message : String(error) },
            tt,
          ),
        );
      }
    },
    [instance, setPendingBadge, resetRun],
  );

  useEffect(() => {
    if (open && instance) {
      // 首次打开即标记（ProviderCard 的「新」圆点据此消失）：localStorage 本地记忆，
      // 主窗/快窗同 origin 共享；广播事件让同窗口的卡片即时摘掉圆点。读写失败
      // 静默——提示性功能，不值得报错
      try {
        localStorage.setItem(tasksOpenedKey(instance.id), "1");
        window.dispatchEvent(new Event(TASKS_OPENED_EVENT));
      } catch {
        /* ignore */
      }
      void reload();
    }
  }, [open, instance, reload]);

  const layers = useMemo(() => layerTasks(tasks ?? []), [tasks]);
  // 执行会话结束（running true→false）自动重扫（silent，保留会话——行内逐项到账
  // 反馈继续可见），把「已点亮/已领取」归位到分组。不限 phase：error 态下也能被
  // 这次重扫治愈（复审边角：error 态吞重扫会让徽标滞留旧值）
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !run?.running) void reload({ silent: true });
    wasRunning.current = Boolean(run?.running);
  }, [run?.running, reload]);

  if (!instance) return null;
  // 能力位兜底：国际站入口已隐藏，此处防误开空抽屉（与 StatsSheet 同例）
  if (!workbuddyApi(workbuddySiteOf(instance)).capabilities.tasks) return null;

  const kindName = t(providerName(instance.providerId));
  const title = displayName(instance, kindName);
  const pendingCount = layers.automatable.length + layers.claimable.length;
  // 已有任务数据时的手动刷新：原地反馈态（列表变暗禁点、按钮转圈），不替换 DOM
  const refreshing = phase === "loading" && tasks !== null;
  const projectedCredit = layers.automatable.reduce((sum, task) => sum + task.rewardCredit, 0);
  // 进度只统计本轮条目（carried 是并入的历史反馈，不计入 {done}/{total}）
  const runItems = run?.items.filter((item) => !item.carried) ?? [];
  const totalItems = runItems.length;
  const finishedItems = runItems.filter((item) => item.status === "done" || item.status === "error").length;

  const runOne = (task: WorkbuddyTask) => startRun(instance, [task], FALLBACK_TITLES);
  const runAll = () => startRun(instance, layers.automatable, FALLBACK_TITLES);
  const claim = async (task: WorkbuddyTask) => {
    setClaiming((current) => [...current, task.taskCode]);
    setClaimFeedback((current) => {
      const { [task.taskCode]: _removed, ...rest } = current;
      return rest;
    });
    try {
      const context = await createTaskContext(instance);
      if (!context) {
        // 存模板不烘焙译文：渲染层统一翻译（与全链路一致）
        setClaimFeedback((current) => ({
          ...current,
          [task.taskCode]: { status: "error", message: "账号信息获取失败，请检查登录状态后重试" },
        }));
        return;
      }
      const result = await claimWorkbuddyTask(context, task);
      // 成功也落行内反馈（复审 N3）：不依赖 silent reload 恰好成功才可见
      setClaimFeedback((current) => ({
        ...current,
        [task.taskCode]: { status: "done", message: result.message, params: result.params },
      }));
    } catch (error) {
      // 领取失败必须可见：挂到行内反馈，不静默（ADR-0024 同哲学）
      setClaimFeedback((current) => ({
        ...current,
        [task.taskCode]:
          error instanceof TaskActionError
            ? { status: "error", message: error.message, params: error.params }
            : {
                status: "error",
                message: "任务执行失败：{detail}",
                params: { detail: error instanceof Error ? error.message : String(error) },
              },
      }));
    } finally {
      setClaiming((current) => current.filter((code) => code !== task.taskCode));
      // 清掉同码执行条目（复审 N1）：陈旧的 done/error 会话条目会把「可领取」行
      // 锁死成已完成 ✓、或遮蔽刚写入的领取反馈
      clearRunItem(instance.id, task.taskCode);
      void reload({ silent: true });
    }
  };

  const rowFeedback = (taskCode: string): RowFeedback | undefined => {
    const item = run?.items.find((entry) => entry.taskCode === taskCode);
    if (item) return { status: item.status, message: item.message, params: item.params };
    return claimFeedback[taskCode];
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby={undefined} className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span>{title}</span>
            <SiteBadge providerId={instance.providerId} site={instance.site} translate={t} />
          </SheetTitle>
          <SheetDescription>{t("成长中心")}</SheetDescription>
        </SheetHeader>
        {/* 连登卡是 SheetBody 的直接子节点（独立于任务区加载态），两卡片之间的间距
            由这里的 flex gap 负责——内层容器的 gap 只管任务卡与风险提示 */}
        <SheetBody className="flex flex-col gap-4">
          {/* 连登区块独立于任务区的加载态：手动刷新任务列表时不随 phase 整区替换
              （体验修复 2026-09-27——loading 曾把连登数据一起换成全屏 spinner） */}
          <StreakSection
            streakFull={streakFull}
            streakFailed={streakFailed}
            streakLoading={growthCtx === null && !streakFailed}
            lotteryChances={lotteryChances}
            butlerRecord={butlerRecord}
            butlerRunning={butlerRunning}
            tierBusy={tierBusy}
            tierError={tierError}
            onRunButler={() => void runButler()}
            onRedeemTier={(tier) => void redeemTierOne(tier)}
          />

          {phase === "loading" && tasks === null ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-fg-muted">
              <LoaderCircle className="h-4 w-4 animate-spin" /> {t("正在获取任务列表")}
            </div>
          ) : phase === "error" && tasks === null ? (
            <EmptyState
              icon={<ListChecks className="h-5 w-5" />}
              title={t("任务列表获取失败")}
              description={error}
              action={
                <Button variant="outline" size="sm" onClick={() => void reload()}>
                  <RefreshCw className="h-3.5 w-3.5" /> {t("重试")}
                </Button>
              }
            />
          ) : (
            <div className="flex flex-col gap-4">
              <section
                className={cn(
                  "rounded-lg border border-line bg-surface shadow-card transition-opacity duration-200",
                  refreshing && "pointer-events-none opacity-50",
                )}
              >
                {/* 区块头与连登卡同构：label 左、操作右；手动刷新是原地反馈
                    （卡片变暗禁点、按钮转圈），不插独立提示行（体验修复 2026-09-27） */}
                <header className="flex items-center justify-between gap-2 px-4 pt-3.5">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">
                    {t("任务")}
                  </p>
                  <div className="flex items-center gap-1.5">
                    <IconButton
                      size="sm"
                      aria-label={t("刷新任务列表")}
                      title={t("刷新任务列表")}
                      disabled={refreshing}
                      onClick={() => void reload({ reset: true })}
                    >
                      {refreshing ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                    </IconButton>
                    {layers.automatable.length > 0 && (
                      <Button
                        size="sm"
                        disabled={run?.running || refreshing}
                        onClick={runAll}
                        title={
                          run?.running
                            ? renderTemplate(t("已处理 {done}/{total} 项"), { done: finishedItems, total: totalItems }, t)
                            : undefined
                        }
                      >
                        {run?.running ? (
                          <>
                            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                            {renderTemplate("{done}/{total}", { done: finishedItems, total: totalItems }, t)}
                          </>
                        ) : (
                          <>
                            <Sparkles className="h-3.5 w-3.5" /> {t("一键完成")}
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                </header>
                <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
                  {phase === "error" && tasks !== null && (
                    <p role="alert" className="text-[11px] text-danger">
                      {error}
                    </p>
                  )}

                  {pendingCount > 0 && (
                    <p className="text-xs text-fg-muted tnum">
                      {renderTemplate(
                        t("{count} 项可自动完成，预计 +{credit} 积分"),
                        { count: pendingCount, credit: projectedCredit },
                        t,
                      )}
                    </p>
                  )}

              {pendingCount === 0 ? (
                <EmptyState
                  icon={<Gift className="h-5 w-5" />}
                  title={t("暂无待办任务")}
                  description={t("新任务随官方活动上架，可稍后再来看看")}
                  className="border-0 bg-transparent py-8"
                />
              ) : (
                <>
                  <TaskGroup label={t("可自动完成")}>
                    {layers.automatable.map((task) => (
                      <TaskRow
                        key={task.taskCode}
                        task={task}
                        title={taskDisplayTitle(task, FALLBACK_TITLES)}
                        state={rowFeedback(task.taskCode)}
                        claiming={claiming.includes(task.taskCode)}
                        onRun={() => runOne(task)}
                        runDisabled={run?.running}
                        runLabel={t("执行")}
                      />
                    ))}
                  </TaskGroup>
                  {layers.claimable.length > 0 && (
                    <TaskGroup label={t("可领取（需在官方客户端完成）")}>
                      {layers.claimable.map((task) => (
                        <TaskRow
                          key={task.taskCode}
                          task={task}
                          title={taskDisplayTitle(task, FALLBACK_TITLES)}
                          state={rowFeedback(task.taskCode)}
                          claiming={claiming.includes(task.taskCode)}
                          onRun={() => void claim(task)}
                          runDisabled={run?.running}
                          runLabel={t("领取")}
                        />
                      ))}
                    </TaskGroup>
                  )}
                </>
              )}

                  {layers.done.length > 0 && (
                    <div className="rounded-lg border border-line">
                      <button
                        type="button"
                        onClick={() => setDoneExpanded((value) => !value)}
                        className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-fg-secondary"
                      >
                        <span className="tnum">
                          {renderTemplate("已完成 {count} 项", { count: layers.done.length }, t)}
                        </span>
                        <ChevronDown
                          className={cn("h-3.5 w-3.5 transition-transform", doneExpanded && "rotate-180")}
                        />
                      </button>
                      {doneExpanded && (
                        <div className="divide-y divide-line border-t border-line">
                          {layers.done.map((task) => (
                            <div key={task.taskCode} className="flex items-center justify-between gap-2 px-3 py-2">
                              <span className="truncate text-xs text-fg-muted">
                                {taskDisplayTitle(task, FALLBACK_TITLES)}
                              </span>
                              <span className="shrink-0 text-[11px] text-fg-muted tnum">
                                {task.rewardCredit > 0 ? `+${task.rewardCredit}` : ""}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </section>

              <p className="px-1 text-[11px] leading-relaxed text-fg-muted">
                {t(
                  "任务由本工具代为完成，存在账号风控风险；「更换主题外观」会真实切换账号主题，「领养第一只喵喵」会真实领养宠物",
                )}
              </p>
            </div>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

/** 连登档位定义（成长中心 7/14/28 天档；参考项目 StreakFull 同口径） */
const TIER_DEFS = ["7d", "14d", "28d"] as const;
const TIER_LABELS: Record<string, string> = { "7d": "7天档", "14d": "14天档", "28d": "28天档" };

/** 管家行内记录的事件行（细节只在抽屉可见，通知只报汇总——ADR-0037 取舍）。
 *  每行是「中文模板 + params」：档位名是字典键（renderTemplate 先 t 值再替换）、
 *  抽奖奖品是服务端动态原文（进 {prize} 不翻译），与全链路 i18n 约定同构 */
interface ButlerRecordLine {
  template: string;
  params?: Record<string, string | number>;
}

function butlerRecordLines(outcome: GrowthButlerOutcome): ButlerRecordLine[] {
  const lines: ButlerRecordLine[] = [];
  if (outcome.makeupUsed > 0) lines.push({ template: "已用补签卡补签昨日" });
  if (outcome.giftCredit > 0) {
    lines.push({ template: "新手礼包 +{credit} 积分", params: { credit: outcome.giftCredit } });
  }
  if (outcome.compensationCredit > 0) {
    lines.push({
      template: "活动补偿 +{credit} 积分",
      params: { credit: outcome.compensationCredit },
    });
  }
  for (const redeem of outcome.redeemed) {
    lines.push({
      template: "兑换 {tier}（+{credit} 积分 +{energy} 能量）",
      params: { tier: TIER_LABELS[redeem.tier] ?? redeem.tier, credit: redeem.credit, energy: redeem.energy },
    });
    const extras = (redeem.cards > 0 ? 1 : 0) + (redeem.chances > 0 ? 1 : 0);
    if (extras === 2) {
      lines.push({
        template: "附补签卡 ×{cards}·抽奖 ×{chances}",
        params: { cards: redeem.cards, chances: redeem.chances },
      });
    } else if (redeem.cards > 0) {
      lines.push({ template: "附补签卡 ×{cards}", params: { cards: redeem.cards } });
    } else if (redeem.chances > 0) {
      lines.push({ template: "附抽奖 ×{chances}", params: { chances: redeem.chances } });
    }
  }
  for (const prize of outcome.draws) {
    lines.push({ template: "抽奖中奖：{prize}", params: { prize } });
  }
  return lines;
}

function StreakSection({
  streakFull,
  streakFailed,
  streakLoading,
  lotteryChances,
  butlerRecord,
  butlerRunning,
  tierBusy,
  tierError,
  onRunButler,
  onRedeemTier,
}: {
  streakFull: WorkbuddyStreakFullData | null;
  streakFailed: boolean;
  streakLoading: boolean;
  lotteryChances: number | null;
  butlerRecord?: GrowthButlerOutcome;
  butlerRunning: boolean;
  tierBusy: string | null;
  tierError?: string;
  onRunButler: () => void;
  onRedeemTier: (tier: string) => void;
}) {
  const t = useT();
  const days = streakFull?.streak?.days;
  // 距档天数纯本地计算（channel.ts nextTierGap）——服务端 next_tier_remaining 语义
  // 无实证（参考项目声明了字段但从不消费），直译出现过「连登 2 天显示差 1 天」的偏差
  const next = typeof days === "number" && days > 0 ? nextTierGap(days) : null;
  const cards = streakFull?.makeup_cards?.balance;
  const tierMeta = (tier: string) =>
    streakFull?.redemption_status?.tiers?.find((item) => item.tier === tier);
  const status = (tier: string) => (streakFull ? tierStatus(streakFull, tier) : "locked");

  return (
    <section className="rounded-lg border border-line bg-surface shadow-card">
      <header className="flex items-center justify-between gap-2 px-4 pt-3.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">
          {t("连登")}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="h-6.5 px-2.5 text-[11px]"
          disabled={butlerRunning}
          onClick={onRunButler}
        >
          {butlerRunning ? (
            <>
              <LoaderCircle className="h-3 w-3 animate-spin" /> {t("正在领取")}
            </>
          ) : (
            t("领取全部奖励")
          )}
        </Button>
      </header>
      <div className="flex flex-col gap-2.5 px-4 pb-3.5 pt-2">
        {streakFull && typeof days === "number" && days > 0 ? (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-lg font-semibold leading-none tnum">
                {renderTemplate(t("连登 {days} 天"), { days }, t)}
              </span>
              {next && (
                <span className="text-xs text-fg-muted tnum">
                  {renderTemplate(t("距 {tier} 天档还差 {gap} 天"), { tier: next.tier, gap: next.gap }, t)}
                </span>
              )}
            </div>
            {next && (
              <Progress value={(days / next.tier) * 100} aria-label={t("距下一档进度")} />
            )}
            <div className="flex gap-1.5">
              {TIER_DEFS.map((tier) => {
                const state = status(tier);
                const meta = tierMeta(tier);
                const busy = tierBusy === tier;
                if (state === "claimed") {
                  return (
                    <span
                      key={tier}
                      className="inline-flex h-6 items-center gap-1 rounded-md bg-success-soft px-2 text-[11px] font-medium text-success-soft-fg"
                    >
                      <Check className="h-3 w-3" /> {t(TIER_LABELS[tier])}
                    </span>
                  );
                }
                if (state === "locked") {
                  return (
                    <span
                      key={tier}
                      className="inline-flex h-6 items-center gap-1 rounded-md bg-surface-2 px-2 text-[11px] text-fg-muted"
                      title={
                        meta?.days != null
                          ? renderTemplate(t("连续登录 {days} 天解锁"), { days: meta.days }, t)
                          : undefined
                      }
                    >
                      <Lock className="h-3 w-3" /> {t(TIER_LABELS[tier])}
                    </span>
                  );
                }
                return (
                  <button
                    key={tier}
                    type="button"
                    disabled={butlerRunning || tierBusy !== null}
                    onClick={() => onRedeemTier(tier)}
                    className="inline-flex h-6 items-center gap-1 rounded-md border border-brand/30 bg-brand-soft px-2 text-[11px] font-medium text-brand transition-colors duration-fast hover:border-brand/60 disabled:opacity-60"
                    title={t("点击兑换")}
                  >
                    {busy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                    {t(TIER_LABELS[tier])}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-fg-muted tnum">
              {renderTemplate(
                t("补签卡 ×{cards} · 抽奖次数 {chances}"),
                { cards: cards ?? 0, chances: lotteryChances ?? 0 },
                t,
              )}
            </p>
          </>
        ) : (
          <p className="text-xs text-fg-muted">
            {streakFailed
              ? t("连登状态获取失败，可稍后重试")
              : streakLoading
                ? t("正在获取连登状态")
                : t("暂无连登数据")}
          </p>
        )}
        {tierError && (
          <p role="alert" className="text-[11px] text-danger">
            {tierError}
          </p>
        )}
        {butlerRecord && (
          <div className="flex flex-col gap-0.5 border-t border-line pt-2.5">
            <p className="text-[11px] font-medium text-fg-secondary">{t("最近一次自动领取")}</p>
            {butlerRecordLines(butlerRecord).length === 0 ? (
              <p className="text-[11px] text-fg-muted">{t("暂无可领的奖励：档位已兑换、无抽奖次数、昨日无漏签")}</p>
            ) : (
              butlerRecordLines(butlerRecord).map((line, index) => (
                <p key={index} className="text-[11px] leading-relaxed text-fg-muted">
                  {renderTemplate(line.template, line.params, t)}
                </p>
              ))
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function TaskGroup({ label, children }: { label: string; children: ReactNode }) {
  // 卡片内的分组：不再自带边框容器（外层 section 已是卡片），层级靠 label + 分隔线
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">{label}</p>
      <div className="flex flex-col divide-y divide-line">{children}</div>
    </div>
  );
}

function TaskRow({
  task,
  title,
  state,
  claiming,
  onRun,
  runDisabled,
  runLabel,
}: {
  task: WorkbuddyTask;
  title: string;
  state?: RowFeedback;
  claiming: boolean;
  onRun: () => void;
  runDisabled?: boolean;
  runLabel: string;
}) {
  const t = useT();
  const busy = state?.status === "running" || state?.status === "pending" || claiming;
  const finished = state?.status === "done";
  return (
    <div className="flex flex-col gap-1 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg-secondary" title={title}>
          {title}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {task.rewardCredit > 0 && (
            <Badge variant="success" className="text-[11px]">+{task.rewardCredit}</Badge>
          )}
          {task.target > 0 && (
            <span className="text-[11px] tabular-nums text-fg-muted">
              {task.current}/{task.target}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-6 min-w-14 px-2 text-[11px]"
            disabled={runDisabled || busy || finished}
            onClick={onRun}
            title={finished ? t("已完成") : busy ? t("执行中") : undefined}
            aria-label={finished ? t("已完成") : busy ? t("执行中") : undefined}
          >
            {busy ? (
              <LoaderCircle className="h-3 w-3 animate-spin" />
            ) : finished ? (
              "✓"
            ) : (
              runLabel
            )}
          </Button>
        </div>
      </div>
      {state?.message && (
        <p
          role={state.status === "error" ? "alert" : undefined}
          className={cn(
            "text-[11px] leading-relaxed",
            state.status === "error" ? "text-danger" : "text-fg-muted",
          )}
        >
          {renderTemplate(state.message, state.params, t)}
        </p>
      )}
    </div>
  );
}
