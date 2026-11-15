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
pub fn collapsed_hit(banner_w: f64) -> Rect {
    // 横幅宽度钳在画布内：命中区不允许超出窗口矩形（越界部分既点不到也拦不到消息）
    let content_w = PILL_W.max(banner_w).min(CANVAS_W);
    (
        (CANVAS_W - content_w) / 2.0 - HIT_MARGIN_X,
        0.0,
        content_w + HIT_MARGIN_X * 2.0,
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

/// 画布在目标屏工作区顶部的物理坐标。水平偏移 `offset`（-1 最左 .. 0 居中 .. 1 最右）
/// 按可移动范围的比例换算——换屏、改系统缩放后仍保持相同的相对位置（对齐岛仔 island_travel）。
/// 可移动范围为 0（屏幕不比画布宽）时只能居中；偏移非法值按 0 处理。
pub fn canvas_origin(work_left: i32, work_top: i32, work_width: u32, scale: f64, offset: f64) -> (i32, i32) {
    let canvas_w = (CANVAS_W * scale).round();
    let travel = ((work_width as f64 - canvas_w) / 2.0).max(0.0);
    let offset = if offset.is_finite() { offset.clamp(-1.0, 1.0) } else { 0.0 };
    let x = work_left as f64 + travel * (1.0 + offset);
    (x.round() as i32, work_top)
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
    pub fn hit_rect(&self, now: Instant, banner_w: f64) -> Rect {
        let crossing = self.animating(now);
        match (self.expanded, crossing) {
            (true, true) if !self.animating_from_expanded => {
                union_rect(expanded_hit(), collapsed_hit(banner_w))
            }
            (true, _) => expanded_hit(),
            (false, true) if self.animating_from_expanded => {
                union_rect(expanded_hit(), collapsed_hit(banner_w))
            }
            (false, _) => collapsed_hit(banner_w),
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
    drag_origin_offset: AtomicU32,
    banner_w: AtomicU32,
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

    fn begin_drag(&self, cursor_x: i64) {
        self.drag_origin_x.store(cursor_x, Ordering::Relaxed);
        // 从当前显示位置起拖：视觉上无跳变（弹簧尚未收敛时也不跳）
        store_f32(&self.drag_origin_offset, self.display_offset());
        self.dragging.store(true, Ordering::Relaxed);
    }

    fn drag_origin(&self) -> (i64, f32) {
        (
            self.drag_origin_x.load(Ordering::Relaxed),
            load_f32(&self.drag_origin_offset),
        )
    }

    fn set_banner_w(&self, width: f32) {
        store_f32(&self.banner_w, width.max(0.0));
    }

    fn banner_w(&self) -> f32 {
        load_f32(&self.banner_w)
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
        // 偏移从设置库取事实源（读失败回居中，不阻断启用）
        let offset = app
            .state::<crate::AppState>()
            .db
            .lock()
            .ok()
            .and_then(|db| db.get_settings().ok())
            .and_then(|settings| settings.get("islandOffsetX").and_then(|value| value.as_f64()))
            .unwrap_or(0.0) as f32;
        runtime.set_target_offset(offset);
        runtime.snap_display();
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
            let origin = canvas_origin(
                geometry.work_left,
                geometry.work_top,
                geometry.work_width,
                geometry.scale,
                runtime.display_offset() as f64,
            );
            let _ = window.set_position(PhysicalPosition::new(origin.0, origin.1));
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

/// 主屏几何快照：工作区顶点 + 宽度（定位基准）与整屏边界（全屏判定基准）。
#[derive(Debug, Default, Clone, Copy)]
struct Geometry {
    work_left: i32,
    work_top: i32,
    work_width: u32,
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
        monitor: (position.x, position.y, position.x + size.width as i32, position.y + size.height as i32),
        scale: monitor.scale_factor(),
    })
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
            // 几何缓存：定位由本线程独占，无需每拍查询窗口
            let mut geometry = Geometry::default();
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
                let dragging = runtime.dragging();
                // ---- 拖动：用光标屏幕 X 与按下时的起点算目标偏移（不取窗口相对坐标，
                // 窗口跟随移动时相对坐标会互相抵消只剩抖动）----
                if dragging {
                    if let (Some(x), Some(_)) = (cursor.map(|c| c.x), Some(())) {
                        let (drag_origin_x, drag_origin_offset) = runtime.drag_origin();
                        let travel = ((geometry.work_width as f64 - (CANVAS_W * geometry.scale).round()) / 2.0)
                            .max(1.0);
                        let raw = drag_origin_offset as f64
                            + (x - drag_origin_x as f64) / travel;
                        // 居中轻微吸附（对齐岛仔 DRAG_MAGNET）：靠近 0 就吸附过去
                        let snapped = if raw.abs() < 0.02 { 0.0 } else { raw };
                        let clamped = snapped.clamp(-1.0, 1.0);
                        runtime.set_target_offset(clamped as f32);
                        glide_target = clamped;
                    }
                } else if dragging_prev {
                    // 松手：目标保持落点，弹簧自然收敛；清驻留计时防「早已悬停超时」立即展开
                    machine.reset_hover();
                    glide_target = runtime.target_offset() as f64;
                }
                dragging_prev = dragging;
                // 弹簧推进：跟随目标（拖动中即光标位置，静止时即落点）
                glide.step(glide_target, (now - last_tick).as_secs_f64());
                last_tick = now;
                // 收敛后直接对齐，避免无限微小步进
                if (glide.pos - glide_target).abs() < 1e-4 && glide.vel.abs() < 1e-3 {
                    glide.snap(glide_target);
                }
                runtime.set_display_offset(glide.pos as f32);
                let origin = canvas_origin(
                    geometry.work_left,
                    geometry.work_top,
                    geometry.work_width,
                    geometry.scale,
                    glide.pos,
                );
                if applied_origin != Some(origin)
                    && window.set_position(PhysicalPosition::new(origin.0, origin.1)).is_ok()
                {
                    applied_origin = Some(origin);
                }
                let banner_w = runtime.banner_w() as f64;
                let inside = cursor
                    .map(|cursor| {
                        let lx = (cursor.x - origin.0 as f64) / geometry.scale;
                        let ly = (cursor.y - origin.1 as f64) / geometry.scale;
                        rect_contains(machine.hit_rect(now, banner_w), lx, ly)
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
    let cursor_x = app.cursor_position().map(|position| position.x as i64).unwrap_or(0);
    runtime.begin_drag(cursor_x);
    Ok(())
}

/// 结束拖动：目标即落点，控制线程弹簧收敛后自然停稳。
/// 返回落点偏移比例，前端回存设置 `islandOffsetX`。
#[tauri::command]
pub fn end_island_drag(app: AppHandle) -> Result<f32, String> {
    let runtime = app.state::<IslandRuntime>();
    runtime.set_dragging(false);
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
}
