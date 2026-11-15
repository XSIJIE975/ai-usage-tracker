/**
 * 灵动岛轮廓路径（ADR-0047）。
 *
 * 形状不是圆角矩形，而是「刘海面板」轮廓（对齐岛仔 shape.rs）：
 * - 顶边与屏幕工作区顶边齐平（y = 0），顶边最宽；
 * - 两侧在 flareHeight 内沿 wing = flare·(1-t)^2.4 收敛到本体侧边，
 *   这一段就是顶部外翻的「肩部」——岛看起来从屏幕边缘长出来；
 * - 本体是竖直侧边 + 底部圆角，底角半径 = 高度的一半时底部为半圆。
 *
 * 路径以轮廓外接矩形左上角为原点，单位与 CSS 逻辑点一致。
 * 描边路径用 `inset: 0.5` 生成：轮廓整体内收半像素后配 1px 描边，
 * 描边正好完整落在表面内侧，不会在屏幕边缘或壁纸上多出一条外溢的线。
 */

export interface IslandOutlineOptions {
  /** 向内收缩距离（描边路径传 0.5） */
  inset?: number;
  /** 是否闭合。表面填充需要闭合；描边不需要——顶部贴着屏幕边缘，不画线 */
  close?: boolean;
}

/** 肩部采样段数：9~16px 高度上 12 段，1x/1.5x 下都看不出折线 */
const SHOULDER_STEPS = 12;
/** 底部圆角采样段数：半径 18~22px，24 段 ≈ 每段 1.2px 弧长 */
const CORNER_STEPS = 24;

/** 肩部曲线：t=0 在屏幕边缘（外翻最宽），t=1 收敛到本体侧边。
 *  (1-t)^2.4 比三次曲线更饱满，过渡更柔（与岛仔同一幂次） */
function wing(t: number, flare: number): number {
  return flare * (1 - Math.pow(1 - t, 2.4));
}

/** 固定两位小数并消掉 -0，路径字符串更短、逐帧比较也更稳定 */
function n(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export function islandOutlinePath(
  width: number,
  height: number,
  flare: number,
  flareHeight: number,
  radius: number,
  { inset = 0, close = true }: IslandOutlineOptions = {},
): string {
  const flareWidth = Math.max(flare, 0);
  const fh = Math.max(Math.min(flareHeight, (height - inset) * 0.5), 0.5);
  const r = Math.max(Math.min(radius - inset, (height - inset) * 0.5), 0.5);
  const bodyLeft = flareWidth + inset;
  const bodyRight = width - inset - flareWidth;
  const bottom = height - inset;

  const points: string[] = [`M${n(inset)} 0`];

  // 左肩：屏幕边缘 → 本体侧边
  for (let i = 1; i <= SHOULDER_STEPS; i++) {
    const t = i / SHOULDER_STEPS;
    points.push(`L${n(inset + wing(t, flareWidth))} ${n(fh * t)}`);
  }

  // 左侧边下行到左下圆角起点
  points.push(`L${n(bodyLeft)} ${n(bottom - r)}`);
  // 左下圆角：从 (bodyLeft, bottom-r) 扫到 (bodyLeft+r, bottom)
  for (let i = 1; i <= CORNER_STEPS; i++) {
    const a = (Math.PI / 2) * (i / CORNER_STEPS);
    points.push(`L${n(bodyLeft + r - r * Math.cos(a))} ${n(bottom - r + r * Math.sin(a))}`);
  }
  // 底边
  points.push(`L${n(bodyRight - r)} ${n(bottom)}`);
  // 右下圆角：从 (bodyRight-r, bottom) 扫到 (bodyRight, bottom-r)
  for (let i = 1; i <= CORNER_STEPS; i++) {
    const a = (Math.PI / 2) * (i / CORNER_STEPS);
    points.push(`L${n(bodyRight - r + r * Math.sin(a))} ${n(bottom - r + r * Math.cos(a))}`);
  }

  // 右侧边上行到肩部起点，再反向采样回到屏幕边缘
  points.push(`L${n(bodyRight)} ${n(fh)}`);
  for (let i = SHOULDER_STEPS - 1; i >= 0; i--) {
    const t = i / SHOULDER_STEPS;
    points.push(`L${n(width - inset - wing(t, flareWidth))} ${n(fh * t)}`);
  }

  if (close) points.push("Z");
  return points.join("");
}
