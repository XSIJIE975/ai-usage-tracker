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
//! 岛的几何不进 `panel_window::PANEL_LABELS`：`ensure_on_screen` 会按工作区钳制面板，
//! 与本模块的「工作区顶部居中」定位互相打架；DPI/换屏由本线程的周期校验兜底。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

/// 画布与几何常量（逻辑点）。前端 `src/components/island/constants.ts` 持同一组值，
/// 改动必须两端同步。
pub const CANVAS_W: f64 = 460.0;
/// 画布高度仅作几何镜像文档：窗口高度由 tauri.conf.json 的静态声明持有，定位只用到宽度
#[allow(dead_code)]
pub const CANVAS_H: f64 = 340.0;
/// 收起胶囊：固定宽 176 × 高 40，与屏幕顶边留 6 空隙。
pub const PILL_W: f64 = 176.0;
pub const PILL_H: f64 = 40.0;
pub const PILL_TOP: f64 = 6.0;
/// 展开面板：固定 424 × 284，顶部与胶囊同位（内容超高由前端内部滚动）。
/// 宽高比画布留出边距——外阴影必须完整落在画布内，被窗口边缘裁切会成方形残影。
pub const PANEL_W: f64 = 424.0;
pub const PANEL_H: f64 = 284.0;
/// 命中区在内容矩形外的扩展边距。
pub const HIT_MARGIN_X: f64 = 12.0;
pub const HIT_MARGIN_Y: f64 = 8.0;

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
/// 几何兜底校验间隔：覆盖 DPI、分辨率与主屏变化（对齐岛仔 placement_at 周期）。
const PLACE_CHECK: Duration = Duration::from_secs(1);
/// 岛禁用后控制线程的休眠间隔。
const POLL_DISABLED: Duration = Duration::from_millis(250);

/// 矩形（x, y, w, h），画布内逻辑坐标。
pub type Rect = (f64, f64, f64, f64);

/// 收起态命中矩形：胶囊外扩边距；顶部边距越过画布顶（6 - 8 < 0）取 0，
/// 即胶囊与屏幕顶边之间的空隙也算命中——光标推到屏幕最顶也要能唤出（对应岛仔 PILL_GAP）。
pub fn collapsed_hit() -> Rect {
    (
        (CANVAS_W - PILL_W) / 2.0 - HIT_MARGIN_X,
        0.0,
        PILL_W + HIT_MARGIN_X * 2.0,
        PILL_TOP + PILL_H + HIT_MARGIN_Y,
    )
}

/// 展开态命中矩形：面板外扩边距，同样从画布顶算起。
pub fn expanded_hit() -> Rect {
    (
        (CANVAS_W - PANEL_W) / 2.0 - HIT_MARGIN_X,
        0.0,
        PANEL_W + HIT_MARGIN_X * 2.0,
        PILL_TOP + PANEL_H + HIT_MARGIN_Y,
    )
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

/// 画布在目标屏工作区顶部水平居中的物理坐标。屏幕比画布窄时贴左不越界。
pub fn canvas_origin(work_left: i32, work_top: i32, work_width: u32, scale: f64) -> (i32, i32) {
    let canvas_w = (CANVAS_W * scale).round() as i64;
    let x = work_left as i64 + (work_width as i64 - canvas_w) / 2;
    (x.max(work_left as i64) as i32, work_top)
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    None,
    Expand,
    Collapse,
}

impl IslandMachine {
    /// 喂入一次光标采样，返回本次发生的切换（供触发前端动画与穿透前置）。
    pub fn observe(&mut self, now: Instant, inside: bool) -> Transition {
        if inside {
            self.leave_since = None;
            let since = *self.hover_since.get_or_insert(now);
            if !self.expanded && now.duration_since(since) >= HOVER_INTENT {
                self.expanded = true;
                self.begin_anim(now, false);
                return Transition::Expand;
            }
        } else {
            self.hover_since = None;
            if self.expanded {
                let since = *self.leave_since.get_or_insert(now);
                if now.duration_since(since) >= LEAVE_DELAY {
                    self.expanded = false;
                    self.begin_anim(now, true);
                    return Transition::Collapse;
                }
            }
        }
        Transition::None
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

    /// 当前命中矩形：展开态取面板、收起态取胶囊，动画期取两态并集。
    pub fn hit_rect(&self, now: Instant) -> Rect {
        let crossing = self.animating(now);
        match (self.expanded, crossing) {
            (true, true) if !self.animating_from_expanded => union_rect(expanded_hit(), collapsed_hit()),
            (true, _) => expanded_hit(),
            (false, true) if self.animating_from_expanded => union_rect(expanded_hit(), collapsed_hit()),
            (false, _) => collapsed_hit(),
        }
    }

    /// 轮询间隔：驻留中/展开/动画期快采，其余慢采。
    pub fn poll_interval(&self, now: Instant) -> Duration {
        if self.expanded || self.animating(now) || self.hover_since.is_some() {
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

/// 岛运行态：enabled 驱动控制线程的采样/休眠，线程本身进程内只起一次。
#[derive(Default)]
pub struct IslandRuntime {
    enabled: AtomicBool,
    started: AtomicBool,
}

impl IslandRuntime {
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }
}

/// 启用/禁用灵动岛。设置开关与启动接线共用；重复调用幂等。
/// 静默启动（--silent）不拦岛：岛是用户 opt-in 的常驻氛围面，不是弹窗。
pub fn apply_island_enabled(app: &AppHandle, enabled: bool) {
    let runtime = app.state::<IslandRuntime>();
    runtime.enabled.store(enabled, Ordering::Relaxed);
    if enabled && !runtime.started.swap(true, Ordering::Relaxed) {
        spawn_controller(app.clone());
    }
    let Some(window) = app.get_webview_window("island") else {
        return;
    };
    if enabled {
        // 同步定位 + 显示，让设置开关即时有反馈；控制线程随后接管采样
        let mut origin = (0, 0);
        let mut scale = 1.0;
        if refresh_geometry(app, &mut origin, &mut scale) {
            let _ = window.set_position(PhysicalPosition::new(origin.0, origin.1));
        }
        let _ = window.show();
        let _ = app.emit("island-shown", ());
    } else {
        let _ = window.set_ignore_cursor_events(true);
        let _ = window.hide();
    }
}

/// 重取主屏工作区几何，更新画布原点与缩放缓存；返回几何是否发生变化。
fn refresh_geometry(app: &AppHandle, origin: &mut (i32, i32), scale: &mut f64) -> bool {
    let Some(monitor) = app.primary_monitor().ok().flatten() else {
        return false;
    };
    let work = monitor.work_area();
    let new_scale = monitor.scale_factor();
    let (x, y) = canvas_origin(work.position.x, work.position.y, work.size.width, new_scale);
    let changed = (x, y) != *origin || new_scale != *scale;
    *origin = (x, y);
    *scale = new_scale;
    changed
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
            // 画布物理原点与缩放缓存：定位由本线程独占，无需每拍查询窗口
            let mut origin = (0, 0);
            let mut scale = 1.0f64;
            loop {
                if !runtime.enabled.load(Ordering::Relaxed) {
                    // 禁用即休眠；机器复位，重新启用时从头判定
                    machine = IslandMachine::default();
                    ignoring = None;
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
                    if refresh_geometry(&app, &mut origin, &mut scale) {
                        let _ = window.set_position(PhysicalPosition::new(origin.0, origin.1));
                    }
                }
                let inside = app
                    .cursor_position()
                    .ok()
                    .map(|cursor| {
                        let lx = (cursor.x - origin.0 as f64) / scale;
                        let ly = (cursor.y - origin.1 as f64) / scale;
                        rect_contains(machine.hit_rect(now), lx, ly)
                    })
                    .unwrap_or(false);
                match machine.observe(now, inside) {
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
                std::thread::sleep(machine.poll_interval(now));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ms: u64) -> Instant {
        Instant::now() + Duration::from_millis(ms)
    }

    #[test]
    fn collapsed_hit_covers_pill_and_extends_to_canvas_top() {
        let (x, y, w, h) = collapsed_hit();
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
        assert_eq!(machine.observe(at(0), true), Transition::None);
        assert!(!machine.expanded());
        assert_eq!(machine.observe(at(199), true), Transition::None);
        // 满 200ms：展开
        assert_eq!(machine.observe(at(200), true), Transition::Expand);
        assert!(machine.expanded());
        // 离开 119ms：保持展开
        assert_eq!(machine.observe(at(400), false), Transition::None);
        assert!(machine.expanded());
        // 满 120ms：收起
        assert_eq!(machine.observe(at(520), false), Transition::Collapse);
        assert!(!machine.expanded());
    }

    #[test]
    fn reentering_resets_leave_timer_and_leaving_resets_hover_timer() {
        let mut machine = IslandMachine::default();
        // 反复进出（每次都不到驻留时长）：永不展开
        for tick in 0..40 {
            assert_eq!(machine.observe(at(tick * 90), tick % 2 == 0), Transition::None);
        }
        // 连续驻留 250ms 后展开
        assert_eq!(machine.observe(at(4000), true), Transition::None);
        assert_eq!(machine.observe(at(4250), true), Transition::Expand);
        // 展开后短暂回到命中区又离开：离开计时被重置
        assert_eq!(machine.observe(at(4400), true), Transition::None);
        assert_eq!(machine.observe(at(4500), false), Transition::None);
        assert_eq!(machine.observe(at(4550), true), Transition::None);
        assert_eq!(machine.observe(at(4600), false), Transition::None);
        assert!(machine.expanded(), "离开未满 120ms 不应收起");
    }

    #[test]
    fn hit_rect_takes_union_during_animation_then_settles() {
        let mut machine = IslandMachine::default();
        let t0 = at(0);
        machine.observe(t0, true);
        assert_eq!(machine.observe(t0 + HOVER_INTENT, true), Transition::Expand);
        let union = machine.hit_rect(t0 + HOVER_INTENT + Duration::from_millis(50));
        let collapsed = collapsed_hit();
        // 并集必须同时盖住胶囊与面板
        assert!(union.0 <= collapsed_hit().0 && union.1 <= collapsed_hit().1);
        assert!(union.2 >= expanded_hit().2 && union.3 >= expanded_hit().3);
        // 动画窗口过后回到展开态命中
        let after = t0 + HOVER_INTENT + ANIM_WINDOW + Duration::from_millis(1);
        assert!(!machine.animating(after));
        assert_eq!(machine.hit_rect(after), expanded_hit());
    }

    #[test]
    fn poll_interval_is_fast_while_engaged_and_slow_when_idle() {
        let mut machine = IslandMachine::default();
        let t0 = at(0);
        assert_eq!(machine.poll_interval(t0), POLL_IDLE);
        machine.observe(t0, true);
        assert_eq!(machine.poll_interval(t0 + Duration::from_millis(50)), POLL_ACTIVE, "驻留中快采");
        machine.observe(t0 + HOVER_INTENT, true);
        assert_eq!(machine.poll_interval(t0 + HOVER_INTENT + Duration::from_millis(10)), POLL_ACTIVE, "展开态快采");
        // 离开计时从第一个「在外」采样起算；满 120ms 触发收起。
        // 收起后的动画窗口内仍快采，动画结束后回到慢采
        let left_at = t0 + HOVER_INTENT + Duration::from_millis(10);
        assert_eq!(machine.observe(left_at, false), Transition::None);
        let collapsed_at = left_at + LEAVE_DELAY + Duration::from_millis(1);
        assert_eq!(machine.observe(collapsed_at, false), Transition::Collapse);
        assert_eq!(machine.poll_interval(collapsed_at + Duration::from_millis(10)), POLL_ACTIVE, "收起动画期快采");
        let settled = collapsed_at + ANIM_WINDOW + Duration::from_millis(1);
        assert_eq!(machine.poll_interval(settled), POLL_IDLE, "收起且无驻留后回到慢采");
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
        assert_eq!(canvas_origin(0, 0, 1920, 1.0), (730, 0));
        assert_eq!(canvas_origin(0, 0, 1920, 1.5), (615, 0));
        // 负坐标主屏（副屏在左）：-2560 + (2560-460)/2
        assert_eq!(canvas_origin(-2560, -400, 2560, 1.0), (-1510, -400));
        // 工作区比画布还窄：贴工作区左缘，不越界
        assert_eq!(canvas_origin(100, 50, 400, 1.0), (100, 50));
    }
}
