import { cn, displayPercentInteger, formatResetDisplay } from "../../lib/utils";
import type { Language } from "../../i18n";
import type { GlanceLine, Translate } from "./data";

export type ResetDisplay = "relative" | "absolute";

interface GlanceLinesProps {
  lines: GlanceLine[];
  translate: Translate;
  language: Language;
  resetDisplay: ResetDisplay;
  now: number;
}

/**
 * 速览的说明行渲染器：迷你卡片环与紧凑行列表共用同一套，避免两种形态再次分叉。
 * 两种形态的指标区都占满整张卡宽度（约 276px），窗口行保持单行；行序完全按快照顺序
 * （窗口 → 余额 → 明细 → 状态只在数据侧决定），这里不重排。
 */
export function GlanceLines({ lines, translate, language, resetDisplay, now }: GlanceLinesProps) {
  return (
    <div className="space-y-0.5">
      {lines.map((line, index) => (
        <GlanceLineRow
          key={`${line.kind}:${index}:${line.label}`}
          line={line}
          translate={translate}
          language={language}
          resetDisplay={resetDisplay}
          now={now}
        />
      ))}
    </div>
  );
}

function GlanceLineRow({
  line,
  translate,
  language,
  resetDisplay,
  now,
}: {
  line: GlanceLine;
  translate: Translate;
  language: Language;
  resetDisplay: ResetDisplay;
  now: number;
}) {
  if (line.kind === "window") {
    const resetText = formatResetDisplay(line.resetsAt, {
      now,
      language,
      translate,
      display: resetDisplay,
    });
    const alternateReset = formatResetDisplay(line.resetsAt, {
      now,
      language,
      translate,
      display: resetDisplay === "absolute" ? "relative" : "absolute",
    });
    return (
      <div className="flex items-baseline gap-1.5 text-[11px] leading-4">
        <span className="min-w-0 flex-1 truncate text-fg-muted" title={line.label}>
          {line.label}
        </span>
        <span className="shrink-0 text-fg-muted">{translate("已用")}</span>
        <span className="tnum shrink-0 font-medium text-fg">
          {displayPercentInteger(line.percent)}%
        </span>
        {resetText ? (
          <span
            className="tnum shrink-0 text-right text-[10px] text-fg-muted"
            title={alternateReset ?? undefined}
          >
            {resetText}
          </span>
        ) : null}
      </div>
    );
  }

  if (line.kind === "balance") {
    return (
      <div className="flex items-baseline justify-between gap-2 text-[11px] leading-4">
        <span className="min-w-0 truncate text-fg-muted" title={line.label}>
          {line.label}
        </span>
        <span className="tnum shrink-0 font-medium text-fg" style={line.color ? { color: line.color } : undefined}>
          {line.value}
        </span>
      </div>
    );
  }

  if (line.kind === "detail") {
    return (
      <div className="flex items-baseline justify-between gap-2 text-[11px] leading-4">
        <span className="min-w-0 truncate text-fg-muted" title={line.label}>
          {line.label}
        </span>
        <span className="tnum shrink-0 text-fg-secondary">{line.value}</span>
      </div>
    );
  }

  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px] leading-4">
      <span className="min-w-0 truncate text-fg-muted" title={line.label}>
        {line.label}
      </span>
      <span
        className={cn("shrink-0", line.color ? "font-medium" : "text-fg-secondary")}
        style={line.color ? { color: line.color } : undefined}
      >
        {line.value}
      </span>
    </div>
  );
}
