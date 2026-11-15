/**
 * 灵动岛几何常量（逻辑点，ADR-0047）。
 * 与 Rust 侧 src-tauri/src/island_window.rs 的同名常量互为镜像——
 * 命中区/窗口定位在 Rust 按这组值判定，前端按同一组值布局，改动必须两端同步。
 *
 * 轮廓（shape.ts）不是圆角矩形：顶边与屏幕工作区顶边齐平，两侧在顶边向外翻出
 * 「肩部」（flare），再在 flareH 内沿 wing = flare·(1-t)^2.4 收敛到本体侧边，
 * 最后以底部圆角收口。岛因此看起来是从屏幕边缘长出来的，而不是浮在桌面上。
 */

/** 画布（窗口）尺寸：即展开态的最大占位（含肩部与投影余量），窗口永不 resize */
export const CANVAS_W = 500;
export const CANVAS_H = 340;

/** 收起胶囊：**顶边与画布顶边齐平**。
 *  PILL_W 是肩部最宽处（含两侧 flare），本体（内容区）宽 = PILL_W - 2 * PILL_FLARE。
 *  高度对齐岛仔的收起药丸（163×30）：32px 只比额度环高 8px，读起来是屏幕边缘的
 *  一条窄带，而不是一颗有厚度的胶囊 */
export const PILL_W = 160;
export const PILL_H = 32;
export const PILL_TOP = 0;
/** 肩部：顶部向外翻出的宽度与收敛高度（曲线见 shape.ts）。
 *  12/10 在 32px 高度上约占三分之一，深色壁纸上也能看出「宽度向屏幕边缘张开」 */
export const PILL_FLARE = 12;
export const PILL_FLARE_H = 10;
/** 底部圆角取高度的一半：收起态底部是半圆，与肩部同族 */
export const PILL_RADIUS = PILL_H / 2;

/** 展开面板：本体（内容区）固定 424 × 284，肩部再向外翻出 PANEL_FLARE。
 *  宽高刻意比画布留出边距——外阴影必须完整落在画布内，被窗口边缘裁切
 *  会在四周形成方形残影（首版实测） */
export const PANEL_W = 424;
export const PANEL_H = 284;
export const PANEL_FLARE = 16;
export const PANEL_FLARE_H = 14;
/** 展开态底部圆角：比收起态略大，形变时与肩部一起插值 */
export const PANEL_RADIUS = 22;
/** 展开态轮廓总宽度（含肩部）——形变弹簧的终点，不是内容宽度 */
export const PANEL_OUTER_W = PANEL_W + PANEL_FLARE * 2;

/** 告警横幅：胶囊临时加宽到的总宽度（P1），命中区由 Rust 随之放宽 */
export const BANNER_W = 300;
/** 横幅自动收回时长 */
export const BANNER_MS = 6000;

/** 展开动画的弹簧参数（进度 0=收起 1=展开）。
 *  对齐岛仔 OPEN_W/OPEN_H (330, 0.70) 与 CLOSE (620, 1.0)：展开略欠阻尼有弹性、
 *  收起临界阻尼干脆收死——这个"张开有韧性、收起不拖泥带水"的反差是流畅感的关键 */
export const OPEN_TUNING = { stiffness: 330, zeta: 0.7 };
export const CLOSE_TUNING = { stiffness: 620, zeta: 1.0 };
/** 横幅加宽/收回的弹簧参数（欠阻尼，与展开同族手感） */
export const BANNER_TUNING = { stiffness: 330, zeta: 0.8 };

/** 内容交叉淡入的进度区间（对齐岛仔 reveal 曲线） */
export const PILL_FADE = [0.55, 0.92] as const;
export const PANEL_FADE = [0.5, 0.97] as const;
