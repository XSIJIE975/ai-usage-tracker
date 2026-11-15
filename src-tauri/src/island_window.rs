//! 灵动岛窗口控制器（ADR-0047）：常驻屏幕顶部工作区居中的透明胶囊，
//! 悬停驻留展开、离开收起；命中区外整窗点击穿透、永不抢焦点。
//!
//! 机制映射自开源项目岛仔 Daozai（MIT）的灵动岛设计：
//! - daozai 用固定画布 + `SetWindowRgn`/`WM_NCHITTEST`→`HTTRANSPARENT` 做区域可见与穿透；
//!   WebView2 的子 HWND 会直接吃掉鼠标消息，父窗口 subclass 拦不到，这里改用
//!   `set_ignore_cursor_events` 整窗切换近似：透明区默认穿透，光标进入命中区、
//!   展开态与切换动画期保持可交互。
//! - daozai 在 egui 每帧里轮询 `GetCursorPos` 驱动 morph 状态机；这里换成独立控制线程
//!   轮询 `app.cursor_position()`，状态机是唯一真相源，前端只负责视觉动画。
//! - 窗口尺寸固定（画布即最大展开占位），展开/收起不触发窗口 resize，
//!   避免 WebView2 重排掉帧。
//!
//! P1（同 ADR 后续节的首四项）：
//! - 拖动换位：胶囊水平拖动改偏移比例（-1..1），展开面板始终留在屏内；拖动期间抑制展开。
//! - 前台切换收起：`SetWinEventHook(EVENT_SYSTEM_FOREGROUND)`（Windows）——切到别的
//!   进程立即收起，且光标离开命中区前不再自动展开（对齐岛仔 hover_lock）。
//! - 全屏避让：前台全屏窗口盖住岛所在屏时整岛隐藏，离开后恢复。
//! - 告警横幅：胶囊临时加宽显示告警，命中区随横幅宽度放宽（宽度由前端上报）。
//!
//! 岛的几何不进 `panel_window::PANEL_LABELS`：`ensure_on_screen` 会按工作区钳制面板，
//! 与本模块的「工作区顶部居中」定位互相打架；DPI/换屏由本线程的周期校验兜底。

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

/// 画布与几何常量（逻辑点）。前端 `src/components/island/constants.ts` 持同一组值，
/// 改动必须两端同步。
pub const CANVAS_W: f64 = 460.0;
/// 画布高度仅作几何镜像文档：窗口高度由 tauri.conf.json 的静态声明持有，定位只用到宽度
#[allow(dead_code)]
pub const CANVAS_H: f64 = 340.0;
/// 拖动换边的判定：光标距目标边 ≤ 此值（逻辑点）才吸附过去。
const SWITCH_EDGE_DISTANCE: f64 = 64.0;
/// 换边还需「明显比当前边更近」的余量——角落处防止横竖形态来回跳变。
const SWITCH_EDGE_MARGIN: f64 = 24.0;
/// 光标必须先离开当前边的吸附带（逻辑点）才允许换边——岛贴边时光标天然离当前边很近，
/// 只比距离会让「沿边滑动」被误判成换边。
const SWITCH_RELEASE_DISTANCE: f64 = 110.0;
/// 收起胶囊：固定宽 196 × 高 40（右侧 24 是拖动握把），与屏幕顶边留 6 空隙。
pub const PILL_W: f64 = 196.0;
pub const PILL_H: f64 = 40.0;
pub const PILL_TOP: f64 = 6.0;
/// 展开面板：固定 424 × 284，顶部与胶囊同位（内容超高由前端内部滚动）。
/// 宽高比画布留出边距——外阴影必须完整落在画布内，被窗口边缘裁切会成方形残影。
pub const PANEL_W: f64 = 424.0;
pub const PANEL_H: f64 = 284.0;
/// 命中区在内容矩形外的扩展边距。
pub const HIT_MARGIN_X: f64 = 12.0;
pub const HIT_MARGIN_Y: f64 = 8.0;

// ---- 侧边停靠（ADR-0047 P2）----
/// 侧边停靠时的画布尺寸：与窗口静态声明一致（竖向画布）。
pub const SIDE_CANVAS_W: f64 = 500.0;
pub const SIDE_CANVAS_H: f64 = 600.0;
/// 侧边收起态竖向胶囊：贴边厚度 36，沿屏幕竖直方向长 132。
pub const SIDE_PILL_W: f64 = 40.0;
pub const SIDE_PILL_H: f64 = 96.0;
/// 侧边胶囊与屏幕边缘的空隙（对应顶部胶囊的 PILL_TOP）。
pub const SIDE_PILL_GAP: f64 = 6.0;
/// 侧边展开面板：沿竖直方向的高度与向屏内伸出的宽度。
pub const SIDE_PANEL_W: f64 = 424.0;
pub const SIDE_PANEL_H: f64 = 284.0;

/// 停靠边。Top 为默认的屏幕顶部水平胶囊；Left/Right 为左右贴边的竖向胶囊。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Dock {
    #[default]
    Top,
    Left,
    Right,
}

impl Dock {
    #[allow(dead_code)]
    pub fn is_side(self) -> bool {
        !matches!(self, Dock::Top)
    }

    /// 设置值 → 枚举；未知值按 Top（默认值兜底，避免坏配置把岛放到屏幕外）。
    pub fn from_str(value: &str) -> Self {
        match value {
            "left" => Dock::Left,
            "right" => Dock::Right,
            _ => Dock::Top,
        }
    }
}

/// 悬停驻留多久后展开（防路过误触；对齐岛仔 HOVER_INTENT）。
const HOVER_INTENT: Duration = Duration::from_millis(200);
/// 光标离开多久后收起（对齐岛仔 LEAVE_DELAY）。
const LEAVE_DELAY: Duration = Duration::from_millis(120);
/// 每次展开/收起切换后的动画窗口：期间命中区取前后两态并集、保持可交互。
const ANIM_WINDOW: Duration = Duration::from_millis(450);
/// 收起且光标未驻留时的轮询间隔（低频省电）。
const POLL_IDLE: Duration = Duration::from_millis(50);
/// 驻留中/展开态/动画期的轮询间隔。
const POLL_ACTIVE: Duration = Duration::from_millis(16);
/// 拖动中的采样间隔兜底：显示器刷新率读不到时按 240Hz 级采样。
const POLL_DRAG_FALLBACK: Duration = Duration::from_millis(4);
/// 刷新率换算间隔时留的余量：采样略快于一帧，保证每帧都有新位置可画
/// （重复位置的写入由 `applied_origin` 去重，空转代价只有一次整数比较）。
const POLL_DRAG_SLACK: f64 = 0.75;
/// 刷新率合法区间：低于下限视为读取失败，高于上限按上限处理（异常值防御）。
const REFRESH_ACCEPT_MIN: u32 = 30;
const REFRESH_ACCEPT_MAX: u32 = 360;
/// 几何兜底校验间隔：覆盖 DPI、分辨率与主屏变化（对齐岛仔 placement_at 周期）。
const PLACE_CHECK: Duration = Duration::from_secs(1);
/// 岛禁用后控制线程的休眠间隔。
const POLL_DISABLED: Duration = Duration::from_millis(250);

/// 矩形（x, y, w, h），画布内逻辑坐标。
pub type Rect = (f64, f64, f64, f64);

/// 收起态命中矩形：胶囊（或横幅）外扩边距；顶部边距越过画布顶（6 - 8 < 0）取 0，
/// 即胶囊与屏幕顶边之间的空隙也算命中——光标推到屏幕最顶也要能唤出（对应岛仔 PILL_GAP）。
/// `banner_w` 为告警横幅显示时的胶囊逻辑宽度（无横幅传 0），命中区随之放宽。
#[cfg(test)]
pub fn collapsed_hit(banner_w: f64) -> Rect {
    collapsed_hit_docked(Dock::Top, banner_w)
}

/// 展开态命中矩形：面板外扩边距，同样从画布顶算起。
#[cfg(test)]
pub fn expanded_hit() -> Rect {
    expanded_hit_docked(Dock::Top)
}

/// 收起态命中矩形（按停靠边）。侧边停靠时胶囊贴画布左/右边缘、竖直居中，
/// 命中区同样向外扩边距，并让贴边一侧越过画布边界取 0（光标推到屏幕边缘也能唤出）。
pub fn collapsed_hit_docked(dock: Dock, banner_w: f64) -> Rect {
    match dock {
        Dock::Top => {
            // 横幅宽度钳在画布内：命中区不允许超出窗口矩形（越界部分既点不到也拦不到消息）
            let content_w = PILL_W.max(banner_w).min(CANVAS_W);
            (
                (CANVAS_W - content_w) / 2.0 - HIT_MARGIN_X,
                0.0,
                content_w + HIT_MARGIN_X * 2.0,
                PILL_TOP + PILL_H + HIT_MARGIN_Y,
            )
        }
        dock => {
            // 竖向胶囊：贴边 6px，沿竖直方向居中；命中区在竖直方向外扩
            let (left, right) = side_capsule_x(dock, SIDE_CANVAS_W);
            (
                left.max(0.0) - if matches!(dock, Dock::Right) { HIT_MARGIN_X } else { 0.0 },
                (SIDE_CANVAS_H - SIDE_PILL_H) / 2.0 - HIT_MARGIN_Y,
                (right - left) + HIT_MARGIN_X,
                SIDE_PILL_H + HIT_MARGIN_Y * 2.0,
            )
        }
    }
}

/// 展开态命中矩形（按停靠边）：侧边停靠时面板从贴边向屏内伸出。
pub fn expanded_hit_docked(dock: Dock) -> Rect {
    match dock {
        Dock::Top => (
            (CANVAS_W - PANEL_W) / 2.0 - HIT_MARGIN_X,
            0.0,
            PANEL_W + HIT_MARGIN_X * 2.0,
            PILL_TOP + PANEL_H + HIT_MARGIN_Y,
        ),
        dock => {
            let (left, right) = side_panel_x(dock, SIDE_CANVAS_W);
            (
                left.max(0.0) - if matches!(dock, Dock::Right) { HIT_MARGIN_X } else { 0.0 },
                (SIDE_CANVAS_H - SIDE_PANEL_H) / 2.0 - HIT_MARGIN_Y,
                (right - left) + HIT_MARGIN_X,
                SIDE_PANEL_H + HIT_MARGIN_Y * 2.0,
            )
        }
    }
}

/// 侧边胶囊在画布内的水平区间（贴边 6px 空隙）。
fn side_capsule_x(dock: Dock, canvas_w: f64) -> (f64, f64) {
    match dock {
        Dock::Right => (canvas_w - SIDE_PILL_GAP - SIDE_PILL_W, canvas_w - SIDE_PILL_GAP),
        _ => (SIDE_PILL_GAP, SIDE_PILL_GAP + SIDE_PILL_W),
    }
}

/// 侧边展开面板在画布内的水平区间：贴边，向屏内伸出 SIDE_PANEL_W。
fn side_panel_x(dock: Dock, canvas_w: f64) -> (f64, f64) {
    match dock {
        Dock::Right => (canvas_w - SIDE_PANEL_W, canvas_w),
        _ => (0.0, SIDE_PANEL_W),
    }
}

pub fn union_rect(a: Rect, b: Rect) -> Rect {
    let left = a.0.min(b.0);
    let top = a.1.min(b.1);
    let right = (a.0 + a.2).max(b.0 + b.2);
    let bottom = (a.1 + a.3).max(b.1 + b.3);
    (left, top, right - left, bottom - top)
}

pub fn rect_contains(rect: Rect, x: f64, y: f64) -> bool {
    x >= rect.0 && x < rect.0 + rect.2 && y >= rect.1 && y < rect.1 + rect.3
}

/// 画布在目标屏工作区顶部的物理坐标。水平偏移 `offset`（-1 最左 .. 0 居中 .. 1 最右）
/// 按可移动范围的比例换算——换屏、改系统缩放后仍保持相同的相对位置（对齐岛仔 island_travel）。
/// 可移动范围为 0（屏幕不比画布宽）时只能居中；偏移非法值按 0 处理。
#[cfg(test)]
pub fn canvas_origin(work_left: i32, work_top: i32, work_width: u32, scale: f64, offset: f64) -> (i32, i32) {
    canvas_origin_docked(Dock::Top, work_left, work_top, work_width, 0, scale, offset)
}

/// 画布原点（按停靠边）。顶部停靠时 offset 走水平轴；侧边停靠时走竖直轴
/// （-1 最上 .. 0 居中 .. 1 最下），水平方向贴所在边的画布左/右缘。
#[allow(clippy::too_many_arguments)]
pub fn canvas_origin_docked(
    dock: Dock,
    work_left: i32,
    work_top: i32,
    work_width: u32,
    work_height: u32,
    scale: f64,
    offset: f64,
) -> (i32, i32) {
    let offset = if offset.is_finite() { offset.clamp(-1.0, 1.0) } else { 0.0 };
    match dock {
        Dock::Top => {
            let travel = travel_px(dock, work_width as f64, scale);
            (
                (work_left as f64 + travel * (1.0 + offset)).round() as i32,
                work_top,
            )
        }
        dock => {
            // 侧边：画布横向贴住所在边（左边缘贴工作区左、右边缘贴工作区右），
            // 竖直方向按 offset 在可移动范围内滑动
            // 可移动范围只由**面板半高**决定（不是画布高）——画布只是窗口容器，
            // 拿它算会额外吃掉几百像素，表现为「离屏幕上下端有一段碰不到」
            // （对齐岛仔：travel = 屏幕高/2 - 面板半高，与拖动投影共用 `travel_px`）。
            let canvas_w = (SIDE_CANVAS_W * scale).round();
            let travel = travel_px(dock, work_height as f64, scale);
            let center_y = work_top as f64 + work_height as f64 / 2.0 + travel * offset;
            let y = center_y - (SIDE_CANVAS_H * scale) / 2.0;
            let x = match dock {
                Dock::Right => work_left as f64 + work_width as f64 - canvas_w,
                _ => work_left as f64,
            };
            (x.round() as i32, y.round() as i32)
        }
    }
}

/// 沿边可滑动范围（物理像素，≥0）：岛中心相对工作区中心的正负最大位移。
/// 「拖动定位」与「停靠定位」共用这一个函数——两侧 travel 口径一致，
/// 比例与像素来回投影才不会漂移。顶部由画布宽决定（画布整体留在屏内）；
/// 侧边由面板半高决定（画布只是窗口容器，拿它算会额外吃掉几百像素，
/// 表现为「离屏幕上下端有一段碰不到」，对齐岛仔 travel = 屏幕高/2 - 面板半高）。
fn travel_px(dock: Dock, work_len: f64, scale: f64) -> f64 {
    let body = match dock {
        Dock::Top => (CANVAS_W * scale).round(),
        _ => SIDE_PANEL_H * scale,
    };
    ((work_len - body) / 2.0).max(0.0)
}

/// 把「期望的像素位置」换算成该停靠边下的偏移比例（只取沿边轴）。
/// 拖动时先用它把像素位置投影回比例，再过 `canvas_origin_docked` —— 于是
/// 岛永远贴边，而沿边方向 1:1 跟手（两函数共用 `travel_px`，往返无漂移）。
/// travel 为 0（几何未就绪、屏幕不比岛体宽/高）时返回 0（居中）——旧实现此处
/// `.max(1.0)` 再钳位，几何为全零时会把岛钉死在边的端点上。
fn offset_from_desired(dock: Dock, geometry: &Geometry, desired_x: f64, desired_y: f64) -> f64 {
    let scale = geometry.scale;
    let travel = match dock {
        Dock::Top => travel_px(dock, geometry.work_width as f64, scale),
        _ => travel_px(dock, geometry.work_height as f64, scale),
    };
    if travel <= 0.0 {
        return 0.0;
    }
    let (center, work_center) = match dock {
        Dock::Top => (
            desired_x + (CANVAS_W * scale).round() / 2.0,
            geometry.work_left as f64 + geometry.work_width as f64 / 2.0,
        ),
        _ => (
            desired_y + SIDE_CANVAS_H * scale / 2.0,
            geometry.work_top as f64 + geometry.work_height as f64 / 2.0,
        ),
    };
    ((center - work_center) / travel).clamp(-1.0, 1.0)
}

/// 把窗口原点反算成偏移比例（-1..1），供松手持久化。原点就是「期望位置」的
/// 像素形式，直接复用同一套投影，保证吸附结果与拖动落点一致。
fn offset_from_origin(dock: Dock, geometry: &Geometry, origin: (i32, i32)) -> f64 {
    offset_from_desired(dock, geometry, origin.0 as f64, origin.1 as f64)
}

/// 拖动一拍的目标原点（纯函数，控制线程与单测共用同一份逻辑）：
/// 期望位置 = 按下时的窗口原点 + 光标位移（绝对像素搬运，不走比例模型，
/// 快速拖动不脱节），再投影回「垂直于边的轴锚死在边线、沿边轴限制在合法区间」
/// ——岛不可能浮到屏幕中间，沿边方向 1:1 跟手。
fn drag_target_origin(
    dock: Dock,
    geometry: &Geometry,
    grab_origin: (i64, i64),
    grab_cursor: (i64, i64),
    cursor: (f64, f64),
) -> (i32, i32) {
    let desired_x = grab_origin.0 as f64 + (cursor.0 - grab_cursor.0 as f64);
    let desired_y = grab_origin.1 as f64 + (cursor.1 - grab_cursor.1 as f64);
    canvas_origin_docked(
        dock,
        geometry.work_left,
        geometry.work_top,
        geometry.work_width,
        geometry.work_height,
        geometry.scale,
        offset_from_desired(dock, geometry, desired_x, desired_y),
    )
}

/// 展开/收起状态机。纯逻辑，与窗口 API 解耦以便单测。
#[derive(Debug, Default)]
pub struct IslandMachine {
    expanded: bool,
    hover_since: Option<Instant>,
    leave_since: Option<Instant>,
    animating_until: Option<Instant>,
    /// 动画起点形态：动画期间命中区取「切换前 + 切换后」两态并集。
    animating_from_expanded: bool,
    /// 展开抑制（对齐岛仔 hover_lock）：前台切走/拖动换位时置位，
    /// 光标离开命中区前不再自动展开。
    locked: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    None,
    Expand,
    Collapse,
}

impl IslandMachine {
    /// 喂入一次光标采样，返回本次发生的切换（供触发前端动画与穿透前置）。
    /// `suppressed` 为真时（拖动中）强制收起且不积累驻留。
    pub fn observe(&mut self, now: Instant, inside: bool, suppressed: bool) -> Transition {
        if !inside {
            self.locked = false;
            self.hover_since = None;
            if self.expanded {
                let since = *self.leave_since.get_or_insert(now);
                if now.duration_since(since) >= LEAVE_DELAY {
                    self.expanded = false;
                    self.begin_anim(now, true);
                    return Transition::Collapse;
                }
            }
            return Transition::None;
        }
        self.leave_since = None;
        if suppressed {
            // 拖动/抑制中：已在展开态则收起，否则保持收起
            self.hover_since = None;
            if self.expanded {
                self.expanded = false;
                self.begin_anim(now, true);
                return Transition::Collapse;
            }
            return Transition::None;
        }
        if self.locked {
            // 光标仍在命中区：不积累驻留，抑制自动展开
            self.hover_since = None;
            return Transition::None;
        }
        let since = *self.hover_since.get_or_insert(now);
        if !self.expanded && now.duration_since(since) >= HOVER_INTENT {
            self.expanded = true;
            self.begin_anim(now, false);
            return Transition::Expand;
        }
        Transition::None
    }

    /// 前台切到别的程序（对齐岛仔 foreground_changed）：立即收起并锁定，
    /// 光标离开命中区前不再自动展开。
    pub fn collapse_and_lock(&mut self, now: Instant) -> Transition {
        self.hover_since = None;
        self.leave_since = None;
        self.locked = true;
        if self.expanded {
            self.expanded = false;
            self.begin_anim(now, true);
            return Transition::Collapse;
        }
        Transition::None
    }

    /// 拖动结束：清掉驻留计时，避免松手瞬间因「早已悬停超时」立刻展开
    pub fn reset_hover(&mut self) {
        self.hover_since = None;
    }

    fn begin_anim(&mut self, now: Instant, from_expanded: bool) {
        self.animating_until = Some(now + ANIM_WINDOW);
        self.animating_from_expanded = from_expanded;
    }

    pub fn expanded(&self) -> bool {
        self.expanded
    }

    pub fn animating(&self, now: Instant) -> bool {
        self.animating_until.is_some_and(|until| now < until)
    }

    /// 当前命中矩形：展开态取面板、收起态取胶囊（含横幅宽度），动画期取两态并集。
    #[cfg(test)]
    pub fn hit_rect(&self, now: Instant, banner_w: f64) -> Rect {
        self.hit_rect_docked(now, Dock::Top, banner_w)
    }

    /// 当前命中矩形（按停靠边）：侧边停靠时胶囊贴边竖排、面板向屏内伸出。
    pub fn hit_rect_docked(&self, now: Instant, dock: Dock, banner_w: f64) -> Rect {
        let collapsed = collapsed_hit_docked(dock, banner_w);
        let expanded = expanded_hit_docked(dock);
        let crossing = self.animating(now);
        match (self.expanded, crossing) {
            (true, true) if !self.animating_from_expanded => union_rect(expanded, collapsed),
            (true, _) => expanded,
            (false, true) if self.animating_from_expanded => union_rect(expanded, collapsed),
            (false, _) => collapsed,
        }
    }

    /// 轮询间隔：拖动中按显示器刷新率（`drag_interval`）驱动，驻留中/展开/动画期
    /// 快采，其余慢采。拖动必须在最前面——拿起时面板已收起、驻留计时已清，
    /// 落到后面会退化成 50ms/拍（20fps，明显卡顿）。
    pub fn poll_interval(&self, now: Instant, dragging: bool, drag_interval: Duration) -> Duration {
        if dragging {
            drag_interval
        } else if self.expanded || self.animating(now) || self.hover_since.is_some() {
            POLL_ACTIVE
        } else {
            POLL_IDLE
        }
    }
}

/// 穿透决策：命中区内、展开态、动画期保持可交互，其余整窗穿透。
pub fn should_ignore(expanded: bool, animating: bool, inside: bool) -> bool {
    !(expanded || animating || inside)
}

/// f32 经 AtomicU32 传递（to_bits/from_bits），供偏移比例与横幅宽度这类高频小量。
fn store_f32(slot: &AtomicU32, value: f32) {
    slot.store(value.to_bits(), Ordering::Relaxed);
}

fn load_f32(slot: &AtomicU32) -> f32 {
    f32::from_bits(slot.load(Ordering::Relaxed))
}

/// 岛运行态：enabled 驱动控制线程的采样/休眠，线程本身进程内只起一次。
///
/// 偏移有两个值，语义区别关键：
/// - `target_offset`：拖动落点（设置里持久化的值）
/// - `display_offset`：弹簧平滑后的当前显示位置，控制线程每拍写，窗口按它定位
/// 拖动期间目标随光标实时更新、显示值用弹簧追——窗口移动因此是 60fps 的连续曲线，
/// 不受 IPC 往返与鼠标事件抖动影响（对齐岛仔 drag_glide 的做法）。
#[derive(Default)]
pub struct IslandRuntime {
    enabled: AtomicBool,
    started: AtomicBool,
    target_offset: AtomicU32,
    display_offset: AtomicU32,
    dragging: AtomicBool,
    /// 拖动起点：按下时的光标屏幕 X（物理像素）与当时的偏移比例。
    /// 起点在 Rust 侧记录——前端若用 `clientX`（相对窗口）算位移，窗口跟随移动时
    /// 相对坐标会互相抵消，只剩抖动（daozai 源码同款注释）。
    drag_origin_x: AtomicI64,
    drag_origin_y: AtomicI64,
    /// 按下时的窗口左上角（物理像素）：拖动期间 origin = 此值 + 光标位移
    drag_window_x: AtomicI64,
    drag_window_y: AtomicI64,
    /// 抓取偏移（光标 - 窗口原点），换边换画布尺寸后仍保持同一抓取点
    drag_grab_dx: AtomicI64,
    drag_grab_dy: AtomicI64,
    banner_w: AtomicU32,
    /// 停靠边：0=Top 1=Left 2=Right（AtomicU8 语义用 u8 槽，避免额外依赖）。
    dock: std::sync::atomic::AtomicU8,
    /// 控制线程最近一次成功写入窗口的画布原点（物理像素）+ 有效性。
    /// `begin_island_drag` 的拖动起点优先取它：`outer_position()` 是异步派发后的
    /// 系统回读，快速连拖/刚启用时可能比写入值旧一拍，会把按下起点记错。
    applied_x: AtomicI64,
    applied_y: AtomicI64,
    applied_valid: AtomicBool,
}

impl IslandRuntime {
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    fn set_target_offset(&self, offset: f32) {
        let clamped = if offset.is_finite() { offset.clamp(-1.0, 1.0) } else { 0.0 };
        store_f32(&self.target_offset, clamped);
    }

    fn target_offset(&self) -> f32 {
        load_f32(&self.target_offset)
    }

    fn display_offset(&self) -> f32 {
        load_f32(&self.display_offset)
    }

    fn set_display_offset(&self, offset: f32) {
        store_f32(&self.display_offset, offset);
    }

    fn snap_display(&self) {
        self.set_display_offset(self.target_offset());
    }

    fn set_dragging(&self, dragging: bool) {
        self.dragging.store(dragging, Ordering::Relaxed);
    }

    fn dragging(&self) -> bool {
        self.dragging.load(Ordering::Relaxed)
    }

    /// `cursor_pos` 为按下时的光标屏幕坐标（物理像素）。顶部停靠取 X、侧边取 Y
    /// 作拖动轴——两轴都记下来，切换停靠边后仍能用同一起点换算。
    /// 记录拖动起点：光标位置 + 窗口原点 + 抓取偏移（光标在窗口内的相对位置）。
    /// 抓取偏移是「跟手」的关键——窗口原点永远等于 光标 - 抓取偏移，
    /// 换画布尺寸后按新尺寸重算原点，光标仍抓在岛的同一处。
    fn begin_drag_at(&self, cursor: (i64, i64), window_origin: (i32, i32)) {
        self.drag_origin_x.store(cursor.0, Ordering::Relaxed);
        self.drag_origin_y.store(cursor.1, Ordering::Relaxed);
        self.drag_window_x.store(window_origin.0 as i64, Ordering::Relaxed);
        self.drag_window_y.store(window_origin.1 as i64, Ordering::Relaxed);
        self.drag_grab_dx.store(cursor.0 - window_origin.0 as i64, Ordering::Relaxed);
        self.drag_grab_dy.store(cursor.1 - window_origin.1 as i64, Ordering::Relaxed);
        self.dragging.store(true, Ordering::Relaxed);
    }

    fn drag_window_origin(&self) -> (i64, i64) {
        (
            self.drag_window_x.load(Ordering::Relaxed),
            self.drag_window_y.load(Ordering::Relaxed),
        )
    }

    fn drag_cursor_origin(&self) -> (i64, i64) {
        (
            self.drag_origin_x.load(Ordering::Relaxed),
            self.drag_origin_y.load(Ordering::Relaxed),
        )
    }

    /// 记录最近一次成功写入窗口的原点（控制线程定位与启用/换边路径共用）。
    /// 这是窗口真实位置的唯一事实源：`set_position` 是异步派发，事后用
    /// `outer_position()` 回读可能拿到旧一拍的值。
    fn note_applied_origin(&self, origin: (i32, i32)) {
        self.applied_x.store(origin.0 as i64, Ordering::Relaxed);
        self.applied_y.store(origin.1 as i64, Ordering::Relaxed);
        self.applied_valid.store(true, Ordering::Relaxed);
    }

    fn last_applied_origin(&self) -> Option<(i32, i32)> {
        self.applied_valid.load(Ordering::Relaxed).then(|| {
            (
                self.applied_x.load(Ordering::Relaxed) as i32,
                self.applied_y.load(Ordering::Relaxed) as i32,
            )
        })
    }

    fn set_banner_w(&self, width: f32) {
        store_f32(&self.banner_w, width.max(0.0));
    }

    fn banner_w(&self) -> f32 {
        load_f32(&self.banner_w)
    }

    fn set_dock(&self, dock: Dock) {
        let value = match dock {
            Dock::Top => 0,
            Dock::Left => 1,
            Dock::Right => 2,
        };
        self.dock.store(value, Ordering::Relaxed);
    }

    fn dock(&self) -> Dock {
        match self.dock.load(Ordering::Relaxed) {
            1 => Dock::Left,
            2 => Dock::Right,
            _ => Dock::Top,
        }
    }
}

/// 偏移显示用的临界阻尼弹簧（对齐岛仔 GLIDE_FOLLOW）：拖动跟手但有惯性，
/// 松手自然停稳。子步积分保证不同帧率下曲线一致。
#[derive(Clone, Copy)]
struct Glide {
    pos: f64,
    vel: f64,
}

impl Glide {
    fn new(value: f64) -> Self {
        Self { pos: value, vel: 0.0 }
    }

    fn step(&mut self, target: f64, dt: f64) {
        // 对齐岛仔 GLIDE_FOLLOW (k=320, zeta=0.72)：略欠阻尼，跟手的同时带一点韧性；
        // 临界阻尼（zeta=1）虽然不抖但手感发死，过高的 k 会让鼠标抖动被完整放大
        const K: f64 = 320.0;
        const ZETA: f64 = 0.72;
        let c = 2.0 * ZETA * K.sqrt();
        let dt = dt.clamp(0.0, 0.1);
        let steps = ((dt * 480.0).ceil() as usize).max(1);
        let h = dt / steps as f64;
        for _ in 0..steps {
            let a = -K * (self.pos - target) - c * self.vel;
            self.vel += a * h;
            self.pos += self.vel * h;
        }
    }

    fn snap(&mut self, value: f64) {
        self.pos = value;
        self.vel = 0.0;
    }
}

/// 启用/禁用灵动岛。设置开关与启动接线共用；重复调用幂等。
/// 启用时偏移比例取落库设置（islandOffsetX），拖动写入运行态、松手时由前端回存设置。
/// 静默启动（--silent）不拦岛：岛是用户 opt-in 的常驻氛围面，不是弹窗。
pub fn apply_island_enabled(app: &AppHandle, enabled: bool) {
    let runtime = app.state::<IslandRuntime>();
    if enabled {
        // 偏移与停靠边从设置库取事实源（读失败回默认值，不阻断启用）
        let settings = app
            .state::<crate::AppState>()
            .db
            .lock()
            .ok()
            .and_then(|db| db.get_settings().ok());
        let offset = settings
            .as_ref()
            .and_then(|settings| settings.get("islandOffsetX").and_then(|value| value.as_f64()))
            .unwrap_or(0.0) as f32;
        let dock = settings
            .as_ref()
            .and_then(|settings| settings.get("islandDock").and_then(|value| value.as_str()))
            .map(Dock::from_str)
            .unwrap_or_default();
        runtime.set_target_offset(offset);
        runtime.snap_display();
        runtime.set_dock(dock);
        // 侧边停靠要换画布尺寸（竖向）；顶部与侧边的窗口尺寸不同，切换时真实改尺寸
        apply_canvas_size(app, dock);
    }
    runtime.enabled.store(enabled, Ordering::Relaxed);
    if enabled && !runtime.started.swap(true, Ordering::Relaxed) {
        spawn_controller(app.clone());
    }
    let Some(window) = app.get_webview_window("island") else {
        return;
    };
    if enabled {
        // 同步定位 + 显示，让设置开关即时有反馈；控制线程随后接管采样
        if let Some(geometry) = read_geometry(app) {
            let origin = canvas_origin_docked(
                runtime.dock(),
                geometry.work_left,
                geometry.work_top,
                geometry.work_width,
                geometry.work_height,
                geometry.scale,
                runtime.display_offset() as f64,
            );
            // 写入成功即登记 applied 缓存：控制线程首拍之前用户就能按下拖动，
            // begin_island_drag 要靠它拿到正确的起点
            if window.set_position(PhysicalPosition::new(origin.0, origin.1)).is_ok() {
                runtime.note_applied_origin(origin);
            }
        }
        let _ = window.show();
        let _ = app.emit("island-shown", ());
    } else {
        let _ = window.set_ignore_cursor_events(true);
        let _ = window.hide();
    }
}

/// 把显示器刷新率换算成拖动时的采样间隔：留 25% 余量让采样略快于一帧，
/// 保证每帧都有新位置；刷新率非法时退回兜底值。纯函数便于单测。
fn refresh_interval(hz: Option<u32>) -> Duration {
    let Some(hz) = hz.filter(|hz| (REFRESH_ACCEPT_MIN..=REFRESH_ACCEPT_MAX).contains(hz)) else {
        return POLL_DRAG_FALLBACK;
    };
    let millis = 1000.0 / hz as f64 * POLL_DRAG_SLACK;
    Duration::from_secs_f64(millis.max(1.0) / 1000.0)
}

/// 读当前显示器刷新率（Hz）。Windows 走 `EnumDisplaySettingsW` 的当前模式
/// （`ENUM_CURRENT_SETTINGS`）；`dmDisplayFrequency` 为 0 或 1 表示「硬件默认」，
/// 视作不可用退回兜底。其余平台 Tauri 不暴露刷新率，也走兜底。
#[cfg(windows)]
fn display_refresh_hz() -> Option<u32> {
    use windows::Win32::Graphics::Gdi::{
        EnumDisplaySettingsW, DEVMODEW, ENUM_CURRENT_SETTINGS,
    };
    let mut mode = DEVMODEW {
        dmSize: std::mem::size_of::<DEVMODEW>() as u16,
        ..Default::default()
    };
    // lpszDeviceName = None → 当前显示设备
    let ok = unsafe { EnumDisplaySettingsW(windows::core::PCWSTR::null(), ENUM_CURRENT_SETTINGS, &mut mode) };
    if !ok.as_bool() {
        return None;
    }
    let hz = mode.dmDisplayFrequency;
    (hz > 1).then_some(hz)
}

#[cfg(not(windows))]
fn display_refresh_hz() -> Option<u32> {
    None
}

/// 按停靠边设置窗口物理尺寸：顶部用横向画布、侧边用竖向画布。
/// 岛的窗口尺寸是唯一的「真实几何」——画布尺寸变化时也要同步物理窗口，
/// 否则透明画布与命中区会错位（命中区按画布坐标算，窗口却没这么大）。
fn apply_canvas_size(app: &AppHandle, dock: Dock) {
    let Some(window) = app.get_webview_window("island") else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let (w, h) = match dock {
        Dock::Top => (CANVAS_W, CANVAS_H),
        _ => (SIDE_CANVAS_W, SIDE_CANVAS_H),
    };
    let size = tauri::PhysicalSize::new((w * scale).round() as u32, (h * scale).round() as u32);
    if let Err(error) = window.set_size(size) {
        eprintln!("灵动岛切换画布尺寸失败：{error}");
    }
}

/// 主屏几何快照：工作区顶点 + 宽度（定位基准）与整屏边界（全屏判定基准）。
#[derive(Debug, Default, Clone, Copy)]
struct Geometry {
    work_left: i32,
    work_top: i32,
    work_width: u32,
    work_height: u32,
    monitor: (i32, i32, i32, i32),
    scale: f64,
}

/// 读取主屏几何；查询失败返回 None（保留上次缓存，不把窗口打到原点）。
fn read_geometry(app: &AppHandle) -> Option<Geometry> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let position = monitor.position();
    let size = monitor.size();
    let work = monitor.work_area();
    Some(Geometry {
        work_left: work.position.x,
        work_top: work.position.y,
        work_width: work.size.width,
        work_height: work.size.height,
        monitor: (position.x, position.y, position.x + size.width as i32, position.y + size.height as i32),
        scale: monitor.scale_factor(),
    })
}

/// 把窗口定位到 origin：set_position 成功才更新两处缓存——线程本地的
/// `applied_origin`（命中区基准）与 runtime 的 applied 缓存（拖动起点事实源）。
/// 相同原点跳过写入；失败不更新缓存，下一拍重试。
fn place_origin<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    runtime: &IslandRuntime,
    applied: &mut Option<(i32, i32)>,
    origin: (i32, i32),
) -> bool {
    if *applied == Some(origin) {
        return true;
    }
    if window.set_position(PhysicalPosition::new(origin.0, origin.1)).is_ok() {
        *applied = Some(origin);
        runtime.note_applied_origin(origin);
        true
    } else {
        false
    }
}

fn spawn_controller(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("island-controller".into())
        .spawn(move || {
            let runtime = app.state::<IslandRuntime>();
            let mut machine = IslandMachine::default();
            // 当前穿透状态缓存：只在变化时调用窗口 API，避免每拍一次跨线程调度
            let mut ignoring: Option<bool> = None;
            let mut placed_at = Instant::now();
            // 全屏避让状态：进入全屏隐藏、退出恢复
            let mut hidden_for_fullscreen = false;
            // 上一拍是否处于拖动：捕捉「拖动结束」边沿以清驻留计时
            let mut dragging_prev = false;
            // 几何缓存：定位由本线程独占，无需每拍查询窗口。
            // 启动即读一次——之前要等 PLACE_CHECK（1 秒）才首次读取，期间是全零默认值：
            // travel 退化、比例被钳到端点，启用后第一秒内拖动会把岛钉死在边的端点上
            let mut geometry = read_geometry(&app).unwrap_or_default();
            // 已应用的画布原点：期望原点（几何 × 显示偏移）每拍与之比对，不同即重定位。
            // 这是「命中区与可见位置永远一致」的保证——拖动改偏移后，窗口与命中区
            // 在同一拍（≤16ms）一起移动，不会出现命中区先走、胶囊滞留原地的错位
            let mut applied_origin: Option<(i32, i32)> = None;
            // 显示偏移的弹簧（拖动跟手 + 松手自然停稳）；拖动起点由 runtime 记录
            let mut glide = Glide::new(0.0);
            let mut glide_target = runtime.target_offset() as f64;
            glide.snap(glide_target);
            // 上一拍时间：glide 弹簧的 dt 来源
            let mut last_tick = Instant::now();
            // 拖动采样间隔：按显示器刷新率换算，随几何校验每秒刷新一次
            //（显示器切刷新率/换屏后自动跟上，无需重启）
            let mut drag_interval = refresh_interval(display_refresh_hz());
            loop {
                if !runtime.enabled.load(Ordering::Relaxed) {
                    // 禁用即休眠；机器复位，重新启用时从头判定
                    machine = IslandMachine::default();
                    ignoring = None;
                    hidden_for_fullscreen = false;
                    applied_origin = None;
                    std::thread::sleep(POLL_DISABLED);
                    continue;
                }
                let now = Instant::now();
                let Some(window) = app.get_webview_window("island") else {
                    std::thread::sleep(POLL_DISABLED);
                    continue;
                };
                if placed_at.elapsed() >= PLACE_CHECK {
                    placed_at = now;
                    if let Some(next) = read_geometry(&app) {
                        geometry = next;
                    }
                    // 刷新率随几何一起复核：用户切到 144/240Hz 后拖动跟手性立即提升
                    drag_interval = refresh_interval(display_refresh_hz());
                }
                // 几何必须有效才定位/拖动：work 区尺寸为 0 说明初始读取失败或显示器
                // 暂不可用，此时 travel 换算全部退化（比例会被钳到端点）。立即重试而非
                // 干等下一个 PLACE_CHECK；仍失败则本拍整段跳过——窗口停在原地，绝不会
                // 被推到错误的边端点上
                if geometry.work_width == 0 || geometry.work_height == 0 {
                    if let Some(next) = read_geometry(&app) {
                        geometry = next;
                    }
                    if geometry.work_width == 0 || geometry.work_height == 0 {
                        std::thread::sleep(POLL_DISABLED);
                        continue;
                    }
                }
                // 全屏避让：前台全屏窗口盖住岛所在屏（整屏边界相等）时整岛隐藏，
                // 离开后恢复。窗口隐藏期间机器复位、原点作废，恢复显示从头判定
                #[cfg(windows)]
                {
                    let fullscreen = foreground_covers_monitor(geometry.monitor);
                    if fullscreen && !hidden_for_fullscreen {
                        hidden_for_fullscreen = true;
                        machine = IslandMachine::default();
                        ignoring = None;
                        applied_origin = None;
                        let _ = window.set_ignore_cursor_events(true);
                        let _ = window.hide();
                        continue;
                    }
                    if !fullscreen && hidden_for_fullscreen {
                        hidden_for_fullscreen = false;
                        let _ = window.show();
                    }
                }
                // 光标采样一次，拖动换算与命中判定共用
                let cursor = app.cursor_position().ok();
                let dock = runtime.dock();
                let dragging = runtime.dragging();
                // ---- 拖动：用光标屏幕 X 与按下时的起点算目标偏移（不取窗口相对坐标，
                // 窗口跟随移动时相对坐标会互相抵消只剩抖动）----
                if dragging {
                    if let Some(c) = cursor {
                        // ---- 拖动：窗口位置 = 按下位置 + 光标位移（不走比例模型）----
                        // 比例模型需要「位置→比例→位置」两次换算，且换边归中会瞬移，
                        // 快速拖动时鼠标与窗口明显脱节。这里直接搬绝对像素：
                        // 记下按下时的窗口原点与光标，之后每拍 origin = start_origin + delta。
                        let (start_x, start_y) = runtime.drag_window_origin();
                        let (start_cx, start_cy) = runtime.drag_cursor_origin();
                        let desired_x = start_x as f64 + (c.x - start_cx as f64);
                        let desired_y = start_y as f64 + (c.y - start_cy as f64);

                        // 1) 边缘吸附判定（沿用岛仔的 64px/24px 阈值）：
                        //    只看光标离哪条边最近，切换时只改形态与停靠边，不动位置
                        let scale = geometry.scale;
                        let to_left = (c.x - geometry.work_left as f64).max(0.0) / scale;
                        let to_right =
                            (geometry.work_left as f64 + geometry.work_width as f64 - c.x).max(0.0) / scale;
                        let to_top = (c.y - geometry.work_top as f64).max(0.0) / scale;
                        let nearest = [(Dock::Top, to_top), (Dock::Left, to_left), (Dock::Right, to_right)]
                            .into_iter()
                            .min_by(|a, b| a.1.total_cmp(&b.1))
                            .unwrap();
                        let current_distance = match runtime.dock() {
                            Dock::Top => to_top,
                            Dock::Left => to_left,
                            Dock::Right => to_right,
                        };
                        // 岛本身贴边，光标在岛上时天然离当前边很近——只比距离会误切。
                        // 额外要求「光标已离开当前停靠边的吸附带」：顶部停靠时要往下拉出
                        // 一段距离才可能切到侧边，反之亦然（对齐岛仔的角落缓冲思路）。
                        let released_current = current_distance > SWITCH_RELEASE_DISTANCE;
                        if nearest.0 != runtime.dock()
                            && nearest.1 <= SWITCH_EDGE_DISTANCE
                            && nearest.1 + SWITCH_EDGE_MARGIN < current_distance
                            && released_current
                        {
                            // 切换形态：换画布尺寸并重设拖动起点，让「当前窗口位置」连续。
                            // 不做偏移归中——位置由像素增量决定，归中会瞬移。
                            runtime.set_dock(nearest.0);
                            apply_canvas_size(&app, nearest.0);
                            // 换尺寸后画布原点会变（左右贴边/竖向画布），重取一次
                            let new_origin = canvas_origin_docked(
                                nearest.0,
                                geometry.work_left,
                                geometry.work_top,
                                geometry.work_width,
                                geometry.work_height,
                                geometry.scale,
                                offset_from_desired(nearest.0, &geometry, desired_x, desired_y),
                            );
                            let _ = place_origin(&window, &runtime, &mut applied_origin, new_origin);
                            // 起点重置为「此刻」：后续增量从当前位置继续累加
                            runtime.begin_drag_at((c.x as i64, c.y as i64), new_origin);
                            let _ = app.emit("island-dock-changed", ());
                        } else {
                            // 贴边锚定 + 单轴跟手：
                            // 顶部停靠固定贴工作区顶、只跟水平；左/右停靠固定贴侧边、只跟竖直。
                            // 另一个轴永远锚在边线上——岛不可能浮到屏幕中间。
                            // 换算走纯函数 drag_target_origin（与单测同一份逻辑），
                            // 内部共用 canvas_origin_docked 的 travel 口径，贴边与沿边
                            // 滑动遵循同一套边界规则。
                            let anchored = drag_target_origin(
                                runtime.dock(),
                                &geometry,
                                (start_x, start_y),
                                (start_cx, start_cy),
                                (c.x, c.y),
                            );
                            let _ = place_origin(&window, &runtime, &mut applied_origin, anchored);
                        }
                        // 拖动期间不推进 glide（位置由像素直接决定），松手时才反算比例
                    }
                } else if dragging_prev {
                    // 松手：把窗口位置吸附到「当前停靠边」的合法区间（贴边/居中约束），
                    // 再反算成偏移比例持久化。拖动期间是自由跟手，吸附只发生在这一刻。
                    // 这一拍必须更新 glide_target/target_offset——它们还停在拖动前的旧值，
                    // 不更新的话下一拍常规定位会把窗口拉回拖动起点（拖了等于没拖）
                    machine.reset_hover();
                    if let Some(applied) = applied_origin {
                        let dock_now = runtime.dock();
                        let ratio = offset_from_origin(dock_now, &geometry, applied);
                        runtime.set_target_offset(ratio as f32);
                        // 让 glide 从「当前实际位置」平滑滑到吸附后的合法位置
                        glide.snap(ratio);
                        glide_target = ratio;
                        runtime.set_display_offset(ratio as f32);
                        applied_origin = None; // 交还给常规定位逻辑
                    }
                }
                dragging_prev = dragging;
                // 弹簧推进：跟随目标（拖动中即光标位置，静止时即落点）
                glide.step(glide_target, (now - last_tick).as_secs_f64());
                last_tick = now;
                // 收敛后直接对齐，避免无限微小步进
                if (glide.pos - glide_target).abs() < 1e-4 && glide.vel.abs() < 1e-3 {
                    glide.snap(glide_target);
                }
                // 拖动期间位置完全由上面的像素增量决定，这里不能再按 glide 覆盖
                //（否则每拍把窗口拉回比例算出的位置，正是「拖动不跟手」的直接原因）。
                // 松手后 dragging 转 false，才恢复「按比例 + 弹簧」的常规定位。
                runtime.set_display_offset(glide.pos as f32);
                let origin = if dragging {
                    // 拖动中：以已应用的原点为准（命中区必须跟实际窗口位置一致）
                    applied_origin.unwrap_or_else(|| {
                        canvas_origin_docked(
                            dock,
                            geometry.work_left,
                            geometry.work_top,
                            geometry.work_width,
                            geometry.work_height,
                            geometry.scale,
                            glide.pos,
                        )
                    })
                } else {
                    let planned = canvas_origin_docked(
                        dock,
                        geometry.work_left,
                        geometry.work_top,
                        geometry.work_width,
                        geometry.work_height,
                        geometry.scale,
                        glide.pos,
                    );
                    let _ = place_origin(&window, &runtime, &mut applied_origin, planned);
                    planned
                };
                let banner_w = runtime.banner_w() as f64;
                let inside = cursor
                    .map(|cursor| {
                        let lx = (cursor.x - origin.0 as f64) / geometry.scale;
                        let ly = (cursor.y - origin.1 as f64) / geometry.scale;
                        rect_contains(machine.hit_rect_docked(now, dock, banner_w), lx, ly)
                    })
                    .unwrap_or(false);
                let mut transition = machine.observe(now, inside, dragging);
                // 前台切到别的程序：立即收起并锁定（光标离开前不再自动展开）
                if take_foreground_change() {
                    let forced = machine.collapse_and_lock(now);
                    if forced == Transition::Collapse && transition != Transition::Collapse {
                        transition = Transition::Collapse;
                    }
                }
                match transition {
                    Transition::Expand => {
                        // 先解除穿透再通知前端展开：切换动画期间面板必须立刻可交互
                        set_ignore(&app, &mut ignoring, false);
                        let _ = app.emit("island-expanded", ());
                    }
                    Transition::Collapse => {
                        let _ = app.emit("island-collapsed", ());
                    }
                    Transition::None => {}
                }
                let ignore = should_ignore(machine.expanded(), machine.animating(now), inside);
                set_ignore(&app, &mut ignoring, ignore);
                std::thread::sleep(machine.poll_interval(now, dragging, drag_interval));
            }
        });
    if let Err(error) = spawned {
        eprintln!("灵动岛控制线程启动失败：{error}");
    }
}

fn set_ignore(app: &AppHandle, current: &mut Option<bool>, want: bool) {
    if current.is_some_and(|value| value == want) {
        return;
    }
    if let Some(window) = app.get_webview_window("island") {
        // WebviewWindow 方法可跨线程调用（内部派发到事件循环）；失败保留旧缓存下次重试
        if window.set_ignore_cursor_events(want).is_ok() {
            *current = Some(want);
        }
    }
}

#[tauri::command]
pub fn set_island_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    if app.get_webview_window("island").is_none() {
        return Err("灵动岛窗口不可用".into());
    }
    apply_island_enabled(&app, enabled);
    Ok(())
}

/// 开始拖动：起点由 Rust 侧记录（当前光标屏幕 X + 当前显示偏移）。
/// 位移换算留在控制线程里做——前端只发这一条，不参与逐帧位移，
/// 从根上避免「窗口跟随移动导致相对坐标抵消」的抖动（daozai 同款教训）。
#[tauri::command]
pub fn begin_island_drag(app: AppHandle) -> Result<(), String> {
    let runtime = app.state::<IslandRuntime>();
    let cursor = app.cursor_position().ok();
    // 窗口原点只在按下时记一次：拖动期间位置 = 此原点 + 光标位移，
    // 不在每拍反查窗口（那会引入一帧延迟，表现为「拖动跟不上鼠标」）。
    // 优先取控制线程最近写入的 applied 缓存——窗口位置的唯一事实源；
    // outer_position() 是异步派发后的系统回读，快速连拖/刚启用时可能比写入值
    // 旧一拍，会把按下起点记错（拖动瞬间跳动）。缓存缺失才兜底回读
    let origin = runtime
        .last_applied_origin()
        .or_else(|| {
            app.get_webview_window("island")
                .and_then(|window| window.outer_position().ok())
                .map(|position| (position.x, position.y))
        })
        .unwrap_or((0, 0));
    runtime.begin_drag_at(
        (
            cursor.map(|position| position.x as i64).unwrap_or(0),
            cursor.map(|position| position.y as i64).unwrap_or(0),
        ),
        origin,
    );
    Ok(())
}

/// 结束拖动：目标即落点，控制线程弹簧收敛后自然停稳。
/// 返回落点偏移比例，前端回存设置 `islandOffsetX`。
/// 落点直接按「控制线程最近写入的原点」同步反算：控制线程的松手吸附要等下一拍，
/// 这里若只回读 target_offset 会拿到拖动前的旧值，前端就把旧位置存回了设置，
/// 表现为「拖了等于没拖、位置永远回不去」。
#[tauri::command]
pub fn end_island_drag(app: AppHandle) -> Result<f32, String> {
    let runtime = app.state::<IslandRuntime>();
    runtime.set_dragging(false);
    if let (Some(geometry), Some(origin)) = (read_geometry(&app), runtime.last_applied_origin()) {
        let ratio = offset_from_origin(runtime.dock(), &geometry, origin);
        runtime.set_target_offset(ratio as f32);
    }
    Ok(runtime.target_offset())
}

/// 当前显示偏移比例（诊断/回存兜底用）。
#[tauri::command]
pub fn get_island_offset(app: AppHandle) -> Result<f32, String> {
    Ok(app.state::<IslandRuntime>().target_offset())
}

/// 告警横幅显示宽度（逻辑点，0 = 无横幅）：命中区随横幅放宽，横幅期间可点击。
#[tauri::command]
pub fn set_island_banner_width(app: AppHandle, width: f32) -> Result<(), String> {
    app.state::<IslandRuntime>().set_banner_w(width);
    Ok(())
}

/// 当前停靠边（拖动结束回存设置用）：前端与偏移一起持久化，
/// 否则重启后岛回到旧边、偏移却按新轴解释。
#[tauri::command]
pub fn get_island_dock(app: AppHandle) -> Result<String, String> {
    Ok(match app.state::<IslandRuntime>().dock() {
        Dock::Top => "top".into(),
        Dock::Left => "left".into(),
        Dock::Right => "right".into(),
    })
}

/// 切换停靠边（top / left / right）：换画布尺寸（横向↔竖向）、按新边重新定位。
/// 偏移比例保留——同一比例在新轴上语义一致（-1 最前 .. 0 居中 .. 1 最后）。
#[tauri::command]
pub fn set_island_dock(app: AppHandle, dock: String) -> Result<(), String> {
    let dock = Dock::from_str(&dock);
    let runtime = app.state::<IslandRuntime>();
    if runtime.dock() == dock {
        return Ok(());
    }
    runtime.set_dock(dock);
    apply_canvas_size(&app, dock);
    // 立即按新边定位一次，不必等控制线程下一拍
    if let (Some(geometry), Some(window)) = (read_geometry(&app), app.get_webview_window("island")) {
        let origin = canvas_origin_docked(
            dock,
            geometry.work_left,
            geometry.work_top,
            geometry.work_width,
            geometry.work_height,
            geometry.scale,
            runtime.display_offset() as f64,
        );
        if window.set_position(PhysicalPosition::new(origin.0, origin.1)).is_ok() {
            runtime.note_applied_origin(origin);
        }
    }
    let _ = app.emit("island-dock-changed", ());
    Ok(())
}

// ---------------- Windows：前台切换钩子与全屏判定 ----------------

/// 前台窗口切到别的进程时置位，由控制线程消费。
#[cfg(windows)]
static FOREGROUND_CHANGED: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
pub fn take_foreground_change() -> bool {
    FOREGROUND_CHANGED.swap(false, Ordering::Relaxed)
}

#[cfg(not(windows))]
pub fn take_foreground_change() -> bool {
    false
}

/// 在主线程安装前台切换钩子（lib.rs setup 调用）。`WINEVENT_OUTOFCONTEXT` 要求安装线程
/// 泵消息——Tauri 主线程跑事件循环正好满足；回调只置原子位，无锁无分配。
/// 仅 Windows：其余平台无对应机制，前台切换不收起（行为降级，不影响其余功能）。
#[cfg(windows)]
pub fn install_foreground_hook() {
    use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};

    unsafe extern "system" fn on_foreground(
        _hook: HWINEVENTHOOK,
        event: u32,
        hwnd: windows::Win32::Foundation::HWND,
        _object: i32,
        _child: i32,
        _thread: u32,
        _time: u32,
    ) {
        use windows::Win32::System::Threading::GetCurrentProcessId;
        use windows::Win32::UI::WindowsAndMessaging::{EVENT_SYSTEM_FOREGROUND, GetWindowThreadProcessId};
        if event != EVENT_SYSTEM_FOREGROUND || hwnd.0.is_null() {
            return;
        }
        let mut pid = 0u32;
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        // 自己（含托盘与各窗口）拿到前台不算「切走」
        if pid != 0 && pid != GetCurrentProcessId() {
            FOREGROUND_CHANGED.store(true, Ordering::Relaxed);
        }
    }

    unsafe {
        let hook = SetWinEventHook(
            windows::Win32::UI::WindowsAndMessaging::EVENT_SYSTEM_FOREGROUND,
            windows::Win32::UI::WindowsAndMessaging::EVENT_SYSTEM_FOREGROUND,
            None,
            Some(on_foreground),
            0,
            0,
            windows::Win32::UI::WindowsAndMessaging::WINEVENT_OUTOFCONTEXT,
        );
        if hook.is_invalid() {
            eprintln!("灵动岛前台切换钩子安装失败：切换程序时岛不会自动收起");
        }
        // 钩子随进程退出销毁，无需显式 UnhookWinEvent
    }
}

#[cfg(not(windows))]
pub fn install_foreground_hook() {}

/// 前台窗口是否全屏盖住给定整屏边界（左、上、右、下，物理像素）。
/// 仅 Windows：其余平台不做全屏避让（行为降级）。
#[cfg(windows)]
fn foreground_covers_monitor(monitor: (i32, i32, i32, i32)) -> bool {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect, IsWindowVisible};

    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.0.is_null() || !IsWindowVisible(hwnd).as_bool() {
            return false;
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        // 全屏窗口与整屏边界重合（最大化的普通窗口是工作区，不会相等）
        rect_equals(
            (rect.left, rect.top, rect.right, rect.bottom),
            monitor,
        )
    }
}

#[cfg(not(windows))]
fn foreground_covers_monitor(_monitor: (i32, i32, i32, i32)) -> bool {
    false
}

/// 物理矩形相等（全屏判定用；右/下为闭端点）。
pub fn rect_equals(a: (i32, i32, i32, i32), b: (i32, i32, i32, i32)) -> bool {
    a == b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ms: u64) -> Instant {
        Instant::now() + Duration::from_millis(ms)
    }

    #[test]
    fn collapsed_hit_covers_pill_and_extends_to_canvas_top() {
        let (x, y, w, h) = collapsed_hit(0.0);
        // 胶囊本体在内
        assert!(rect_contains((x, y, w, h), CANVAS_W / 2.0, PILL_TOP + PILL_H / 2.0));
        // 顶边空隙（胶囊与画布顶之间）也算命中
        assert!(rect_contains((x, y, w, h), CANVAS_W / 2.0, 1.0));
        // 左右外扩边距外不算
        assert!(!rect_contains((x, y, w, h), x - 0.1, PILL_TOP + PILL_H / 2.0));
        assert!(!rect_contains((x, y, w, h), x + w + 0.1, PILL_TOP + PILL_H / 2.0));
        // 底边外不算
        assert!(!rect_contains((x, y, w, h), CANVAS_W / 2.0, y + h + 0.1));
    }

    #[test]
    fn collapsed_hit_widens_with_banner() {
        let plain = collapsed_hit(0.0);
        let banner = collapsed_hit(300.0);
        assert!(banner.2 > plain.2, "横幅期间命中区必须更宽");
        assert!(banner.0 < plain.0);
        // 横幅宽度小于胶囊时取胶囊宽
        assert_eq!(collapsed_hit(PILL_W - 40.0).2, plain.2);
        // 横幅宽度不会超出画布
        assert!(collapsed_hit(CANVAS_W + 200.0).2 <= CANVAS_W + HIT_MARGIN_X * 2.0);
    }

    #[test]
    fn expanded_hit_covers_panel() {
        let (x, y, w, h) = expanded_hit();
        assert!(rect_contains((x, y, w, h), CANVAS_W / 2.0, PILL_TOP + 10.0));
        assert!(rect_contains((x, y, w, h), CANVAS_W / 2.0, PILL_TOP + PANEL_H - 10.0));
        assert!(!rect_contains((x, y, w, h), CANVAS_W / 2.0, y + h + 0.1));
    }

    #[test]
    fn hover_must_dwell_before_expanding_and_leave_must_dwell_before_collapsing() {
        let mut machine = IslandMachine::default();
        // 进入 199ms：只驻留不展开
        assert_eq!(machine.observe(at(0), true, false), Transition::None);
        assert!(!machine.expanded());
        assert_eq!(machine.observe(at(199), true, false), Transition::None);
        // 满 200ms：展开
        assert_eq!(machine.observe(at(200), true, false), Transition::Expand);
        assert!(machine.expanded());
        // 离开 119ms：保持展开
        assert_eq!(machine.observe(at(400), false, false), Transition::None);
        assert!(machine.expanded());
        // 满 120ms：收起
        assert_eq!(machine.observe(at(520), false, false), Transition::Collapse);
        assert!(!machine.expanded());
    }

    #[test]
    fn reentering_resets_leave_timer_and_leaving_resets_hover_timer() {
        let mut machine = IslandMachine::default();
        // 反复进出（每次都不到驻留时长）：永不展开
        for tick in 0..40 {
            assert_eq!(machine.observe(at(tick * 90), tick % 2 == 0, false), Transition::None);
        }
        // 连续驻留 250ms 后展开
        assert_eq!(machine.observe(at(4000), true, false), Transition::None);
        assert_eq!(machine.observe(at(4250), true, false), Transition::Expand);
        // 展开后短暂回到命中区又离开：离开计时被重置
        assert_eq!(machine.observe(at(4400), true, false), Transition::None);
        assert_eq!(machine.observe(at(4500), false, false), Transition::None);
        assert_eq!(machine.observe(at(4550), true, false), Transition::None);
        assert_eq!(machine.observe(at(4600), false, false), Transition::None);
        assert!(machine.expanded(), "离开未满 120ms 不应收起");
    }

    #[test]
    fn drag_suppresses_expansion_and_collapses() {
        let mut machine = IslandMachine::default();
        // 拖动中悬停不积累、不展开
        assert_eq!(machine.observe(at(0), true, true), Transition::None);
        assert_eq!(machine.observe(at(500), true, true), Transition::None);
        assert!(!machine.expanded());
        // 已展开时进入拖动：立即收起
        let mut machine = IslandMachine::default();
        machine.observe(at(0), true, false);
        assert_eq!(machine.observe(at(200), true, false), Transition::Expand);
        assert_eq!(machine.observe(at(300), true, true), Transition::Collapse);
        assert!(!machine.expanded());
        // 松手后驻留清零：不会因「早已悬停超时」立刻展开
        machine.reset_hover();
        assert_eq!(machine.observe(at(305), true, false), Transition::None);
    }

    #[test]
    fn foreground_switch_collapses_and_locks_until_cursor_leaves() {
        let mut machine = IslandMachine::default();
        machine.observe(at(0), true, false);
        assert_eq!(machine.observe(at(200), true, false), Transition::Expand);
        // 切走：立即收起并锁定
        assert_eq!(machine.collapse_and_lock(at(250)), Transition::Collapse);
        // 光标仍在命中区（未离开）：驻留不积累，不重新展开
        assert_eq!(machine.observe(at(2000), true, false), Transition::None);
        assert!(!machine.expanded());
        // 光标离开后锁定解除，再次驻留可展开
        assert_eq!(machine.observe(at(3000), false, false), Transition::None);
        assert_eq!(machine.observe(at(4000), true, false), Transition::None);
        assert_eq!(machine.observe(at(4200), true, false), Transition::Expand);
    }

    #[test]
    fn hit_rect_takes_union_during_animation_then_settles() {
        let mut machine = IslandMachine::default();
        let t0 = at(0);
        machine.observe(t0, true, false);
        assert_eq!(machine.observe(t0 + HOVER_INTENT, true, false), Transition::Expand);
        let union = machine.hit_rect(t0 + HOVER_INTENT + Duration::from_millis(50), 0.0);
        let collapsed = collapsed_hit(0.0);
        // 并集必须同时盖住胶囊与面板
        assert!(union.0 <= collapsed.0 && union.1 <= collapsed.1);
        assert!(union.2 >= expanded_hit().2 && union.3 >= expanded_hit().3);
        // 动画窗口过后回到展开态命中
        let after = t0 + HOVER_INTENT + ANIM_WINDOW + Duration::from_millis(1);
        assert!(!machine.animating(after));
        assert_eq!(machine.hit_rect(after, 0.0), expanded_hit());
    }

    #[test]
    fn poll_interval_is_fast_while_engaged_and_slow_when_idle() {
        let mut machine = IslandMachine::default();
        let idle_interval = refresh_interval(None);
        let t0 = at(0);
        assert_eq!(machine.poll_interval(t0, false, idle_interval), POLL_IDLE);
        machine.observe(t0, true, false);
        assert_eq!(
            machine.poll_interval(t0 + Duration::from_millis(50), false, idle_interval),
            POLL_ACTIVE,
            "驻留中快采"
        );
        machine.observe(t0 + HOVER_INTENT, true, false);
        assert_eq!(
            machine.poll_interval(t0 + HOVER_INTENT + Duration::from_millis(10), false, idle_interval),
            POLL_ACTIVE,
            "展开态快采"
        );
        // 离开计时从第一个「在外」采样起算；满 120ms 触发收起。
        // 收起后的动画窗口内仍快采，动画结束后回到慢采
        let left_at = t0 + HOVER_INTENT + Duration::from_millis(10);
        assert_eq!(machine.observe(left_at, false, false), Transition::None);
        let collapsed_at = left_at + LEAVE_DELAY + Duration::from_millis(1);
        assert_eq!(machine.observe(collapsed_at, false, false), Transition::Collapse);
        assert_eq!(
            machine.poll_interval(collapsed_at + Duration::from_millis(10), false, idle_interval),
            POLL_ACTIVE,
            "收起动画期快采"
        );
        let settled = collapsed_at + ANIM_WINDOW + Duration::from_millis(1);
        assert_eq!(machine.poll_interval(settled, false, idle_interval), POLL_IDLE, "收起且无驻留后回到慢采");
        // 拖动中无视其余状态，一律用刷新率换算的间隔
        assert_eq!(machine.poll_interval(settled, true, Duration::from_micros(3125)), Duration::from_micros(3125));
    }

    #[test]
    fn drag_interval_follows_monitor_refresh_rate() {
        // 60Hz → 12.5ms（留 25% 余量）；144Hz → ~5.2ms；240Hz → ~3.1ms
        let close = |actual: Duration, expected_us: u64| {
            let diff = actual.as_micros().abs_diff(expected_us as u128);
            assert!(diff <= 2, "期望 {expected_us}µs，实际 {}µs", actual.as_micros());
        };
        close(refresh_interval(Some(60)), 12_500);
        close(refresh_interval(Some(144)), 5_208);
        close(refresh_interval(Some(240)), 3_125);
        // 越高刷新率间隔越短，且永远非零（不能 0 导致忙等）
        let mut previous = Duration::MAX;
        for hz in [30u32, 60, 90, 120, 144, 165, 240, 360] {
            let interval = refresh_interval(Some(hz));
            assert!(interval > Duration::ZERO, "{hz}Hz 间隔不能为 0");
            assert!(interval < previous, "{hz}Hz 应比 {previous:?} 更短");
            previous = interval;
        }
        // 读取失败与异常值（硬件默认 0/1、过高）一律退回兜底
        for hz in [None, Some(0), Some(1), Some(1000)] {
            assert_eq!(refresh_interval(hz), POLL_DRAG_FALLBACK, "{hz:?} 应退回兜底");
        }
    }

    #[test]
    fn ignore_decision_keeps_island_interactive_only_when_engaged() {
        assert!(should_ignore(false, false, false), "收起且光标在外：穿透");
        assert!(!should_ignore(false, false, true), "光标在命中区：可交互");
        assert!(!should_ignore(true, false, false), "展开态：可交互");
        assert!(!should_ignore(false, true, false), "动画期：可交互");
    }

    #[test]
    fn canvas_origin_centers_on_work_area_and_respects_scale() {
        assert_eq!(canvas_origin(0, 0, 1920, 1.0, 0.0), (730, 0));
        assert_eq!(canvas_origin(0, 0, 1920, 1.5, 0.0), (615, 0));
        // 负坐标主屏（副屏在左）：-2560 + (2560-460)/2
        assert_eq!(canvas_origin(-2560, -400, 2560, 1.0, 0.0), (-1510, -400));
        // 工作区比画布还窄：贴工作区左缘，不越界
        assert_eq!(canvas_origin(100, 50, 400, 1.0, 0.0), (100, 50));
    }

    #[test]
    fn glide_converges_smoothly_and_suppresses_tiny_jitter() {
        // 一次目标突变：弹簧连续追赶、无跳变、最终收敛
        let mut glide = Glide::new(0.0);
        let mut previous = glide.pos;
        let mut max_step: f64 = 0.0;
        for _ in 0..60 {
            glide.step(0.5, 1.0 / 60.0);
            max_step = max_step.max((glide.pos - previous).abs());
            previous = glide.pos;
        }
        assert!((glide.pos - 0.5).abs() < 1e-3, "60 帧内应收敛到目标");
        assert!(max_step < 0.15, "单帧位移不应跳变（实测 {max_step:.3}）");
        assert!(glide.vel.abs() < 1e-2, "收敛后应静止");
    }

    #[test]
    fn glide_is_frame_rate_independent() {
        let mut fast = Glide::new(0.0);
        let mut slow = Glide::new(0.0);
        // 同一物理时长 0.3s：240Hz 与 30Hz 的末态应一致
        for _ in 0..72 {
            fast.step(1.0, 1.0 / 240.0);
        }
        for _ in 0..9 {
            slow.step(1.0, 1.0 / 30.0);
        }
        assert!((fast.pos - slow.pos).abs() < 5e-3, "不同帧率轨迹应一致：{} vs {}", fast.pos, slow.pos);
    }

    #[test]
    fn side_dock_hug_the_edges_and_center_vertically() {
        // 左停靠：画布贴工作区左缘；右停靠：贴右缘
        assert_eq!(canvas_origin_docked(Dock::Left, 0, 0, 1920, 1080, 1.0, 0.0), (0, (1080 - 600) / 2));
        assert_eq!(
            canvas_origin_docked(Dock::Right, 0, 0, 1920, 1080, 1.0, 0.0),
            (1920 - 500, (1080 - 600) / 2)
        );
        // 竖直偏移：travel = 屏幕高/2 - 面板半高 = 540 - 142 = 398。
        // offset=-1 时岛中心贴到 y=142（面板上缘正好在 0），画布顶 = 142 - 300 = -158；
        // offset=+1 时画布顶 = -158 + 2*398 = 638。画布比屏幕高、会露出屏外，
        // 但露出的部分本来就透明（岛体在屏内），这是「上下都能拖到头」的代价与收益。
        assert_eq!(canvas_origin_docked(Dock::Left, 0, 0, 1920, 1080, 1.0, -1.0).1, -158);
        assert_eq!(canvas_origin_docked(Dock::Left, 0, 0, 1920, 1080, 1.0, 1.0).1, 638);
        // 顶部停靠不受高度影响（走水平轴）
        assert_eq!(canvas_origin_docked(Dock::Top, 0, 0, 1920, 1080, 1.0, 0.0), (730, 0));
    }

    #[test]
    fn side_hit_rects_stay_inside_the_canvas() {
        for dock in [Dock::Left, Dock::Right] {
            let collapsed = collapsed_hit_docked(dock, 0.0);
            let expanded = expanded_hit_docked(dock);
            // 竖向胶囊竖直居中、贴边
            assert!(collapsed.1 >= 0.0 && collapsed.1 + collapsed.3 <= SIDE_CANVAS_H + HIT_MARGIN_Y);
            // 面板向屏内伸出，宽度覆盖 SIDE_PANEL_W
            assert!(expanded.2 >= SIDE_PANEL_W, "{dock:?} 面板命中宽度不足：{}", expanded.2);
            // 命中区不越出画布左右边界（贴边一侧可到 0，另一侧不超出画布宽）
            assert!(collapsed.0 >= -HIT_MARGIN_X && expanded.0 + expanded.2 <= SIDE_CANVAS_W + HIT_MARGIN_X);
        }
        // 右停靠时胶囊靠右：左边界应远大于 0
        let right = collapsed_hit_docked(Dock::Right, 0.0);
        assert!(right.0 > SIDE_CANVAS_W / 2.0, "右停靠胶囊应贴右缘");
        let left = collapsed_hit_docked(Dock::Left, 0.0);
        assert!(left.0 < SIDE_CANVAS_W / 2.0, "左停靠胶囊应贴左缘");
    }

    #[test]
    fn dock_parsing_falls_back_to_top() {
        assert_eq!(Dock::from_str("left"), Dock::Left);
        assert_eq!(Dock::from_str("right"), Dock::Right);
        assert_eq!(Dock::from_str("top"), Dock::Top);
        assert_eq!(Dock::from_str("garbage"), Dock::Top);
        assert!(!Dock::Top.is_side() && Dock::Left.is_side() && Dock::Right.is_side());
    }

    #[test]
    fn canvas_origin_offset_moves_by_travel_ratio_and_clamps() {
        // travel = (1920-460)/2 = 730；offset -1 → 左缘 0，+1 → 右缘 1460
        assert_eq!(canvas_origin(0, 0, 1920, 1.0, -1.0), (0, 0));
        assert_eq!(canvas_origin(0, 0, 1920, 1.0, 1.0), (1460, 0));
        assert_eq!(canvas_origin(0, 0, 1920, 1.0, 0.5), (1095, 0));
        // 越界与非法值按边界/居中处理
        assert_eq!(canvas_origin(0, 0, 1920, 1.0, 3.0), (1460, 0));
        assert_eq!(canvas_origin(0, 0, 1920, 1.0, f64::NAN), (730, 0));
        // 窄屏 travel=0：任何偏移都居中（固定一侧必然把画布推出屏外）
        assert_eq!(canvas_origin(100, 50, 400, 1.0, 0.8), (100, 50));
        // 换屏/换缩放后比例语义不变：同一 offset 在 1.5x 屏上按其 travel 换算
        //（canvas 物理宽 690，travel 1575；offset ±1 时画布恰好贴到屏缘）
        assert_eq!(canvas_origin(0, 0, 3840, 1.5, -1.0), (0, 0));
        assert_eq!(canvas_origin(0, 0, 3840, 1.5, 1.0), (3150, 0));
    }

    fn work_geometry() -> Geometry {
        Geometry {
            work_left: 0,
            work_top: 0,
            work_width: 1920,
            work_height: 1080,
            monitor: (0, 0, 1920, 1080),
            scale: 1.0,
        }
    }

    #[test]
    fn drag_target_origin_follows_cursor_one_to_one_along_top_edge() {
        let geometry = work_geometry();
        // 居中按下：画布原点 (730, 0)，光标在画布上任意处
        let grab_origin = (730i64, 0i64);
        let grab_cursor = (900i64, 20i64);
        for delta in [5i64, 37, -64, 120, -9, 300, -260] {
            let cursor = ((grab_cursor.0 + delta) as f64, (grab_cursor.1 + 3) as f64);
            let origin = drag_target_origin(Dock::Top, &geometry, grab_origin, grab_cursor, cursor);
            let expected = (grab_origin.0 + delta) as i32;
            assert!(
                (origin.0 - expected).abs() <= 1,
                "顶部停靠水平必须 1:1 跟手：delta {delta} → x {}（期望 {expected}±1）",
                origin.0
            );
            // 另一轴锚死在工作区顶：光标竖直方向动了也不允许岛脱离顶边
            assert_eq!(origin.1, geometry.work_top, "顶部停靠竖直必须锚在工作区顶");
        }
    }

    #[test]
    fn drag_target_origin_clamps_to_edge_without_floating() {
        let geometry = work_geometry();
        // 拖过头：钳在画布贴工作区左/右缘，岛整体不出屏
        let left = drag_target_origin(Dock::Top, &geometry, (730, 0), (900, 20), (-3000.0, 40.0));
        assert_eq!(left.0, 0, "左端应贴工作区左缘");
        assert_eq!(left.1, 0);
        let right = drag_target_origin(Dock::Top, &geometry, (730, 0), (900, 20), (9000.0, 40.0));
        assert_eq!(right.0, 1460, "右端应贴工作区右缘（travel 730 × 2）");
        // 光标拉到屏幕中下方，岛仍然贴顶——不可能浮到屏幕中间
        let pulled_down = drag_target_origin(Dock::Top, &geometry, (730, 0), (900, 20), (1000.0, 900.0));
        assert_eq!(pulled_down.0, 830);
        assert_eq!(pulled_down.1, 0);
    }

    #[test]
    fn drag_side_dock_tracks_vertical_one_to_one_and_stays_glued_to_side() {
        let geometry = work_geometry();
        // 左停靠居中：画布原点 (0, 240)，竖直方向 1:1 跟手、水平贴左缘
        let grab_origin = (0i64, 240i64);
        let grab_cursor = (20i64, 400i64);
        for delta in [-120i64, -40, 0, 55, 210, 350] {
            let cursor = ((grab_cursor.0 + 7) as f64, (grab_cursor.1 + delta) as f64);
            let origin = drag_target_origin(Dock::Left, &geometry, grab_origin, grab_cursor, cursor);
            let expected = (grab_origin.1 + delta) as i32;
            assert!(
                (origin.1 - expected).abs() <= 1,
                "侧边停靠竖直必须 1:1 跟手：delta {delta} → y {}（期望 {expected}±1）",
                origin.1
            );
            assert_eq!(origin.0, 0, "左停靠必须贴工作区左缘，光标横移也不脱离");
        }
        // 右停靠贴右缘（画布宽 500）
        let origin = drag_target_origin(Dock::Right, &geometry, (1420, 240), (1900, 400), (1905.0, 430.0));
        assert_eq!(origin.0, 1420);
        assert_eq!(origin.1, 270);
        // 上下拖过头：钳在面板可及范围（travel 398 → 画布顶 -158 / 638），岛中心不出屏
        let top = drag_target_origin(Dock::Left, &geometry, (0, 240), (20, 400), (20.0, -2000.0));
        assert_eq!(top.1, -158);
        let bottom = drag_target_origin(Dock::Left, &geometry, (0, 240), (20, 400), (20.0, 4000.0));
        assert_eq!(bottom.1, 638);
    }

    #[test]
    fn offset_projection_round_trips_pixel_origins() {
        // 非 1.0 缩放（画布物理宽 690 非整十）也要成立：拖动投影与停靠定位共用
        // travel_px，比例↔像素往返不得漂移——漂移会在拖动中表现为位置回弹
        let geometry = Geometry { scale: 1.5, ..work_geometry() };
        for dock in [Dock::Top, Dock::Left, Dock::Right] {
            for offset in [-1.0, -0.6, 0.0, 0.4, 1.0] {
                let origin = canvas_origin_docked(dock, 0, 0, 1920, 1080, 1.5, offset);
                let back = offset_from_desired(dock, &geometry, origin.0 as f64, origin.1 as f64);
                assert!(
                    (back - offset).abs() < 2e-3,
                    "{dock:?} offset {offset} 经像素往返后得 {back}（容差 0.5px 换算）"
                );
                // 松手持久化走的 offset_from_origin 必须与拖动投影同一口径
                assert_eq!(
                    offset_from_origin(dock, &geometry, origin),
                    back,
                    "{dock:?} 松手反算与拖动投影口径不一致"
                );
            }
        }
    }

    #[test]
    fn degenerate_travel_centers_instead_of_clamping_to_edge_endpoints() {
        // 几何未就绪（全零）或屏幕不比岛体宽：travel 为 0，比例必须回 0（居中）。
        // 旧实现在这里 .max(1.0) 后钳位，全零几何会把期望位置压成 ±1 → 岛钉死在端点
        assert_eq!(travel_px(Dock::Top, 0.0, 0.0), 0.0);
        let empty = Geometry::default();
        assert_eq!(offset_from_desired(Dock::Top, &empty, 12_345.0, 0.0), 0.0);
        assert_eq!(offset_from_desired(Dock::Right, &empty, 0.0, -99_999.0), 0.0);
        let narrow = Geometry { work_width: 400, ..work_geometry() };
        assert_eq!(travel_px(Dock::Top, 400.0, 1.0), 0.0);
        assert_eq!(offset_from_desired(Dock::Top, &narrow, 2_000.0, 0.0), 0.0);
        // 侧边 travel 只由面板半高决定：屏幕高 1080、面板 284 → 398
        assert_eq!(travel_px(Dock::Left, 1080.0, 1.0), 398.0);
    }
}
