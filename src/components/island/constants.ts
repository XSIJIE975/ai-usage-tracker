/**
 * 灵动岛几何常量（逻辑点，ADR-0047）。
 * 与 Rust 侧 src-tauri/src/island_window.rs 的同名常量互为镜像——
 * 命中区/窗口定位在 Rust 按这组值判定，前端按同一组值布局，改动必须两端同步。
 */

/** 画布（窗口）尺寸：即展开态的最大占位，窗口永不 resize */
export const CANVAS_W = 460;
export const CANVAS_H = 340;

/** 收起胶囊：固定宽高，与画布顶边的空隙 */
export const PILL_W = 176;
export const PILL_H = 40;
export const PILL_TOP = 6;

/** 展开面板：固定尺寸，内容超出由面板内部滚动。
 *  宽高刻意比画布各留出 18/50px——外阴影必须完整落在画布内，被窗口边缘裁切
 *  会在四周形成方形残影（首版实测） */
export const PANEL_W = 424;
export const PANEL_H = 284;

/** 展开动画的弹簧参数（进度 0=收起 1=展开） */
export const OPEN_TUNING = { stiffness: 260, zeta: 0.92 };
export const CLOSE_TUNING = { stiffness: 320, zeta: 0.95 };

/** 内容交叉淡入的进度区间（对齐岛仔 reveal 曲线） */
export const PILL_FADE = [0.55, 0.92] as const;
export const PANEL_FADE = [0.5, 0.97] as const;
