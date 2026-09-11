//! 托盘图标方案体系与速览面板锚定（ADR-0016）。
//! 图标呈现抽象为可切换方案：「默认」= 静态图标 + 告警红点；「用量环」= 主指标环形进度；
//! 「用量柱」= 双横向胶囊条（短窗 + 主指标，参考 CodexBar 的双条用量指示器）。
//! 渲染在 Rust 侧完成（tiny-skia，无文字、零字体依赖）：静默启动与关窗驻留下
//! webview 可能隐藏、canvas 渲染节流不可靠，而托盘必须在这两种状态下照常工作。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;
use tiny_skia::{
    Color, FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, Shader, Stroke, Transform,
};

use crate::commands::tray_tooltip;

/// 计量图标（环/柱）颜色：静态品牌色（鸢尾 iris-500，与界面 --brand 一致）+ 告警红，
/// 不随用量档位变色；轨道为半透明灰
const RING_COLOR_NORMAL: (u8, u8, u8) = (0x6A, 0x63, 0xF0);
const RING_COLOR_DANGER: (u8, u8, u8) = (0xDC, 0x26, 0x26);
const RING_COLOR_TRACK: (u8, u8, u8, f32) = (0x88, 0x88, 0x95, 0.42);

/// 多层环几何（ADR-0017）：16px 基准的 (半径, 描边)，外→内排列，实现按 s/16 缩放。
/// 内环加粗是刻意的可辨性补偿：半径越小弧长越短，加粗补回视觉重量。
/// 已知妥协：16px + 三层 + 内环低百分比时内环弧约 1.6px，只能辨「有无」不能读精确值。
const RING_LAYERS_TWO: [(f32, f32); 2] = [(6.67, 2.0), (3.67, 2.2)];
const RING_LAYERS_THREE: [(f32, f32); 3] = [(6.67, 1.5), (4.43, 1.8), (2.2, 2.0)];

/// 层序数组上限：环最多表达三扇配额窗，超出部分由前端截断（此处防御性再截一次）
pub const RING_LAYERS_MAX: usize = 3;

/// 托盘图标呈现方案
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TrayScheme {
    #[default]
    Default,
    UsageRing,
    UsageBars,
}

impl TrayScheme {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "default" => Some(Self::Default),
            "usage-ring" => Some(Self::UsageRing),
            "usage-bars" => Some(Self::UsageBars),
            _ => None,
        }
    }
}

/// 前端在刷新完成/告警态变化时推送的计量快照
#[derive(Debug, Clone, Default)]
pub struct TrayMeter {
    /// 环的单层回退百分比（选中实例的最紧窗口）；None = 无可绘数据。
    /// 多层化后仅作 ring_windows 缺失时的兜底（ADR-0017）；数字标题由 badge_percent 承载（ADR-0020）
    pub ring_percent: Option<f64>,
    /// 环层序百分比（ADR-0017）：外→内按窗口周期短→长排位、取最紧三扇，由前端排序截断后推送；
    /// 空 = 无层数据（回退 ring_percent 单层）
    pub ring_windows: Vec<f64>,
    /// macOS 数字标题的来源（ADR-0020）：最紧窗口已用百分比（全窗最大值，与选例主键同源）。
    /// 显式字段、与环层序解耦——数字正确性不依赖「最紧必入图」；None = 无数字
    pub badge_percent: Option<f64>,
    /// 柱的上条（已用%最高两窗中重置较近的）；None = 无柱可绘
    pub bar_top: Option<f64>,
    /// 柱的下条（重置较远的）；None = 上条单条居中
    pub bar_bottom: Option<f64>,
    /// 任一实例处于活跃告警（含余额告警），计量方案强制红
    pub alert: bool,
    /// 已本地化的多行摘要（首行实例名，其后每窗一行），用于动态 tooltip
    pub summary: Option<String>,
}

/// 托盘呈现的共享状态：方案、计量快照、界面语言、glance 隐藏时刻（blur 竞态判定）
/// 与上一次写进状态项的呈现（呈现指纹，ADR-0019）
#[derive(Default)]
pub struct TrayState {
    pub scheme: Mutex<TrayScheme>,
    pub meter: Mutex<Option<TrayMeter>>,
    pub language: Mutex<String>,
    pub glance_hidden_at: Mutex<Option<Instant>>,
    /// 呈现指纹（ADR-0019）：内容没变就不碰状态项，避免 macOS 上无谓重建重绘
    pub presentation: Mutex<Option<Presentation>>,
}

/// 呈现指纹：上一次真正写进状态项的三部分内容（ADR-0019）。
///
/// 为什么必须比对：macOS 上每个 setter 都会重建状态项——tray-icon 0.24.2 的
/// `set_icon_for_ns_status_item_button` 走「PNG 编码 → 新建 NSImage → `setImage` →
/// `setImagePosition(ImageLeft)`」，`set_title_inner` 走 `button.setTitle`，两者末尾都调
/// `tray_target.update_dimensions()`（内部 `setFrame`）。因此内容一字未改的重放，用户看到的是
/// 图标旁数字肉眼可见地闪一下（D 方案：数据没变就不许重绘）。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Presentation {
    /// 图标位图（尺寸 + 直通 RGBA）：DPI 档位或用量变化才不同
    pub icon: Option<(u32, u32, Vec<u8>)>,
    /// macOS 图标旁的数字标题；空串 = 无数字（不可用 None，见 `badge_text`）
    pub title: String,
    pub tooltip: String,
}

/// 呈现差异：需要写入的三部分（图标 / 提示 / 标题），与上次一致的部分不必调用对应 setter
fn presentation_changes(previous: Option<&Presentation>, next: &Presentation) -> (bool, bool, bool) {
    match previous {
        Some(previous) => (
            previous.icon != next.icon,
            previous.tooltip != next.tooltip,
            previous.title != next.title,
        ),
        // 首次应用（进程启动）：三件套全写
        None => (true, true, true),
    }
}

/// macOS 图标旁的数字标题：用量环方案 = 最紧窗口已用百分比取整（ADR-0020）——数字回答
/// 「离下一次撞限额还有多远」，随最紧窗切换，与图标外环不必对应；其余方案为空串。
///
/// 为什么是空串而不是 None：tray-icon 0.24.2 的 `set_title_inner` 是 `if let Some(title)`，
/// 传 `None` 在 macOS 是**空操作**——从「用量环」切到「默认 / 用量柱」后，旧数字会永远留在
/// 菜单栏上（Windows/Linux 的 set_title 是空实现，传什么都不会有副作用）。
fn badge_text(scheme: TrayScheme, badge_percent: Option<f64>) -> String {
    match scheme {
        TrayScheme::UsageRing => badge_percent
            .map(|percent| format!("{}", percent.round()))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

impl TrayState {
    pub fn meter(&self) -> Option<TrayMeter> {
        self.meter.lock().expect("tray meter lock poisoned").clone()
    }

    pub fn language(&self) -> String {
        self.language
            .lock()
            .expect("tray language lock poisoned")
            .clone()
    }
}

/// 动态 tooltip：告警态沿用现有后缀；常态拼最紧（或钉选）实例摘要
pub fn tooltip_text(language: &str, meter: Option<&TrayMeter>) -> String {
    if meter.is_some_and(|meter| meter.alert) {
        return tray_tooltip(language, true);
    }
    let title = tray_tooltip(language, false);
    match meter.and_then(|meter| meter.summary.as_deref()) {
        Some(summary) if !summary.is_empty() => {
            // Windows 托盘 tooltip 仅识别 CRLF 换行，多行摘要（每条配额窗口一行）需转换
            #[cfg(target_os = "windows")]
            let summary = summary.replace('\n', "\r\n");
            format!("{title} — {summary}")
        }
        _ => title,
    }
}

/// 按当前方案与计量快照重放托盘呈现（图标 + tooltip + macOS 标题）。
/// 切换方案、推送计量、语言变化、DPI 变化后都要调一次；重放是**幂等**的——
/// 与上次内容一致的部分不会写进状态项（呈现指纹，ADR-0019），所以重复调用不会让状态项闪烁。
pub fn apply(app: &tauri::AppHandle) {
    let Some(tray) = app.tray_by_id("main-tray") else {
        return;
    };
    let state = app.state::<TrayState>();
    let scheme = *state.scheme.lock().expect("tray scheme lock poisoned");
    let meter = state.meter();
    let language = state.language();

    let alert = meter.as_ref().is_some_and(|meter| meter.alert);
    let bar_top = meter.as_ref().and_then(|meter| meter.bar_top);
    let bar_bottom = meter.as_ref().and_then(|meter| meter.bar_bottom);
    // 环层数据（ADR-0017）：优先层序数组，缺失回退单值 ring_percent（单层兼容，亦为旧前端快照兜底）
    let ring_percents = meter
        .as_ref()
        .map(|meter| ring_layer_percents(&meter.ring_windows, meter.ring_percent))
        .unwrap_or_default();
    // badge 数字（ADR-0020）：显式字段，不从 ring_windows 推断
    let badge_percent = meter.as_ref().and_then(|meter| meter.badge_percent);

    // 图标按主窗口 DPI 档位绘制（100%→16px、125%→20px、150%→24px、200%→32px）
    let scale = app
        .get_webview_window("main")
        .and_then(|window| window.scale_factor().ok())
        .unwrap_or(1.0);
    let size = ((16.0 * scale).round() as u32).clamp(16, 32);

    let icon = match (scheme, ring_percents.first(), bar_top) {
        (TrayScheme::UsageRing, Some(_), _) => {
            draw_usage_ring(size, &ring_percents, alert).unwrap_or_else(|| fallback_icon(app, alert))
        }
        (TrayScheme::UsageBars, _, Some(top)) => {
            draw_usage_bars(size, top, bar_bottom, alert)
                .unwrap_or_else(|| fallback_icon(app, alert))
        }
        _ => fallback_icon(app, alert),
    };
    let presentation = Presentation {
        icon: Some((icon.width(), icon.height(), icon.rgba().to_vec())),
        title: badge_text(scheme, badge_percent),
        tooltip: tooltip_text(&language, meter.as_ref()),
    };

    // 指纹比对与写入分两段：tray-icon 的 setter 会把闭包派发到主线程并等待
    // （run_item_main_thread），若持着锁等主线程、而主线程恰好也在 apply 里等这把锁，
    // 就是一个真实的死锁面——锁内只做比对。
    let previous = state
        .presentation
        .lock()
        .expect("tray presentation lock poisoned")
        .clone();
    let (write_icon, write_tooltip, write_title) = presentation_changes(previous.as_ref(), &presentation);

    // 写入与记账分离（ADR-0024）：setter **成功**才把对应字段记为已应用，失败保留旧值——
    // 下一次 apply() 即使内容未变也会因指纹差异重试，托盘在 Explorer 重启等竞态后自愈；
    // 旧实现「先记账后写入」会让失败被永久跳过（告警红点该出现却缺席）。
    // 内容没变的部分一个 setter 都不调（ADR-0019）：macOS 状态项只在真的变化时重建重绘
    let mut committed = previous.clone().unwrap_or_default();
    if write_icon && tray.set_icon(Some(icon)).is_ok() {
        committed.icon = presentation.icon.clone();
    }
    if write_tooltip && tray.set_tooltip(Some(presentation.tooltip.as_str())).is_ok() {
        committed.tooltip = presentation.tooltip.clone();
    }
    if write_title && tray.set_title(Some(presentation.title.as_str())).is_ok() {
        committed.title = presentation.title.clone();
    }
    *state
        .presentation
        .lock()
        .expect("tray presentation lock poisoned") = Some(committed);
}

/// 环层数据解析（ADR-0017）：优先层序数组 ring_windows（外→内），缺失回退单值
/// ring_percent（单层兼容）；两者皆缺 = 无可绘数据。
fn ring_layer_percents(ring_windows: &[f64], ring_percent: Option<f64>) -> Vec<f64> {
    if !ring_windows.is_empty() {
        ring_windows.to_vec()
    } else {
        ring_percent.map(|percent| vec![percent]).unwrap_or_default()
    }
}

/// 默认方案图标：告警时叠加红点（原 set_tray_alert 行为，ADR-0016 收编为默认方案）
fn fallback_icon(app: &tauri::AppHandle, alert: bool) -> tauri::image::Image<'static> {
    let Some(default_icon) = app.default_window_icon() else {
        return tauri::image::Image::new_owned(Vec::new(), 0, 0);
    };
    let mut rgba = default_icon.rgba().to_vec();
    let width = default_icon.width();
    let height = default_icon.height();
    if alert {
        let (width_i, height_i) = (width as i32, height as i32);
        let (center_x, center_y, radius) = (width_i - 10, height_i - 10, 8);
        for y in (center_y - radius - 1).max(0)..=(center_y + radius + 1).min(height_i - 1) {
            for x in (center_x - radius - 1).max(0)..=(center_x + radius + 1).min(width_i - 1) {
                let dx = x - center_x;
                let dy = y - center_y;
                let dist2 = dx * dx + dy * dy;
                let index = ((y as usize) * (width as usize) + (x as usize)) * 4;
                if dist2 <= (radius - 2) * (radius - 2) {
                    rgba[index] = RING_COLOR_DANGER.0;
                    rgba[index + 1] = RING_COLOR_DANGER.1;
                    rgba[index + 2] = RING_COLOR_DANGER.2;
                    rgba[index + 3] = 255;
                } else if dist2 <= radius * radius {
                    rgba[index] = 255;
                    rgba[index + 1] = 255;
                    rgba[index + 2] = 255;
                    rgba[index + 3] = 255;
                }
            }
        }
    }
    tauri::image::Image::new_owned(rgba, width, height)
}

/// 绘制用量环（ADR-0017 多层化）：每层独立画「灰色轨道全环 + 品牌色进度弧」，
/// 层序外→内（外环 = 最短周期窗），顶部起点顺时针、圆头端点；告警时整环红色。
/// 单层沿用旧单环几何（与历史版本像素级一致）；2/3 层按 16px 基准缩放的嵌套几何。
fn draw_usage_ring(size: u32, percents: &[f64], alert: bool) -> Option<tauri::image::Image<'static>> {
    let mut pixmap = Pixmap::new(size, size)?;
    let s = size as f32;
    let (cx, cy) = (s / 2.0, s / 2.0);
    let layers = percents.len().clamp(1, RING_LAYERS_MAX);
    let specs = ring_layer_specs(size, layers);
    for ((radius, stroke_width), percent) in specs.iter().zip(percents.iter().take(layers)) {
        draw_ring_layer(&mut pixmap, cx, cy, *radius, *stroke_width, *percent, alert);
    }
    Some(pixmap_to_image(&pixmap))
}

/// 环层几何（ADR-0017）：按层数给出 (半径, 描边)，外→内。
/// 单层 = 旧单环公式（stroke=max(0.15s, 2)、外缘留 2% 边距）；多层 = 16px 基准常量 × s/16。
fn ring_layer_specs(size: u32, layers: usize) -> Vec<(f32, f32)> {
    let s = size as f32;
    let scale = s / 16.0;
    match layers {
        0 | 1 => {
            let stroke_width = (s * 0.15).max(2.0);
            let radius = (s - stroke_width) / 2.0 - s * 0.02;
            vec![(radius, stroke_width)]
        }
        2 => RING_LAYERS_TWO
            .iter()
            .map(|(radius, stroke)| (radius * scale, stroke * scale))
            .collect(),
        _ => RING_LAYERS_THREE
            .iter()
            .map(|(radius, stroke)| (radius * scale, stroke * scale))
            .collect(),
    }
}

/// 画单层环：灰色轨道全环 + 按百分比的进度弧（顶部起点顺时针，接近满圈留极小缝）
fn draw_ring_layer(
    pixmap: &mut Pixmap,
    cx: f32,
    cy: f32,
    radius: f32,
    stroke_width: f32,
    percent: f64,
    alert: bool,
) {
    if let Some(track) = PathBuilder::from_circle(cx, cy, radius) {
        stroke_path(
            pixmap,
            &track,
            color(
                RING_COLOR_TRACK.0,
                RING_COLOR_TRACK.1,
                RING_COLOR_TRACK.2,
                RING_COLOR_TRACK.3,
            )
            .expect("轨道色固定合法"),
            stroke_width,
        );
    }

    let fraction = (percent / 100.0).clamp(0.0, 1.0);
    if fraction <= f64::EPSILON {
        return;
    }
    // 顶部起点顺时针；接近满圈时留极小缝，避免起终点重合的绘制异常
    let sweep = (fraction * 360.0).min(359.6) as f32;
    let steps = ((sweep / 5.0).ceil() as usize).max(2);
    let mut builder = PathBuilder::new();
    for i in 0..=steps {
        let angle = (-90.0_f32 + sweep * (i as f32 / steps as f32)).to_radians();
        let (x, y) = (cx + radius * angle.cos(), cy + radius * angle.sin());
        if i == 0 {
            builder.move_to(x, y);
        } else {
            builder.line_to(x, y);
        }
    }
    if let Some(path) = builder.finish() {
        let (r, g, b) = meter_color(alert);
        stroke_path(
            pixmap,
            &path,
            color(r, g, b, 1.0).expect("计量色固定合法"),
            stroke_width,
        );
    }
}

/// 计量元素颜色：静态品牌色、不随用量档位变化，仅活跃告警强制红
fn meter_color(alert: bool) -> (u8, u8, u8) {
    if alert {
        RING_COLOR_DANGER
    } else {
        RING_COLOR_NORMAL
    }
}

/// 绘制用量柱：两根横向胶囊条、上下堆叠、自左侧填充；
/// 上条 = 重置较近的窗（如 5 小时额度），下条 = 重置较远的窗（如周配额），
/// 由前端选好「已用%最高的两个窗口」再按近→远传入。下条缺失时上条垂直居中。
/// 每条按各自百分比独立着色（静态品牌色），告警时强制红。
fn draw_usage_bars(
    size: u32,
    top: f64,
    bottom: Option<f64>,
    alert: bool,
) -> Option<tauri::image::Image<'static>> {
    let mut pixmap = Pixmap::new(size, size)?;
    let s = size as f32;
    let bar_height = (s * 0.20).max(2.0);
    let bar_length = s * 0.68;
    let gap = s * 0.14;
    let left = (s - bar_length) / 2.0;
    let right = left + bar_length;
    let cap_radius = bar_height / 2.0;

    let percents: Vec<f64> = match bottom {
        Some(value) => vec![top, value],
        None => vec![top],
    };
    let total_height = bar_height * percents.len() as f32 + gap * (percents.len() as f32 - 1.0);
    let mut center_y = (s - total_height) / 2.0 + cap_radius;

    for percent in percents {
        // 轨道：全长胶囊（圆头线段，端点距左/右各留一个圆头半径）
        let track = line_path(left + cap_radius, center_y, right - cap_radius, center_y)?;
        stroke_path(
            &mut pixmap,
            &track,
            color(
                RING_COLOR_TRACK.0,
                RING_COLOR_TRACK.1,
                RING_COLOR_TRACK.2,
                RING_COLOR_TRACK.3,
            )?,
            bar_height,
        );

        // 填充：左侧锚定的胶囊；核心段不足 1px 时退化为左端圆点。
        // 颜色为静态品牌色（与环一致），告警时强制红
        let fraction = (percent / 100.0).clamp(0.0, 1.0);
        if fraction > f64::EPSILON {
            let core = (bar_length - bar_height) * fraction as f32;
            let (r, g, b) = meter_color(alert);
            let paint = color(r, g, b, 1.0)?;
            // 退化圆点必须「填充」而不是「描边」：对半径为 cap_radius 的圆路径施以
            // width=bar_height 的描边，外半径会变成 cap_radius + bar_height/2 = bar_height，
            // 即直径 2×条厚的胖圆点（比轨道高一倍，还会把上下两条连成一坨）。此处按条厚填充。
            if core < 1.0 {
                fill_path(
                    &mut pixmap,
                    &PathBuilder::from_circle(left + cap_radius, center_y, cap_radius)?,
                    paint,
                );
            } else {
                stroke_path(
                    &mut pixmap,
                    &line_path(left + cap_radius, center_y, left + cap_radius + core, center_y)?,
                    paint,
                    bar_height,
                );
            }
        }
        center_y += bar_height + gap;
    }

    Some(pixmap_to_image(&pixmap))
}

fn line_path(x1: f32, y1: f32, x2: f32, y2: f32) -> Option<tiny_skia::Path> {
    let mut builder = PathBuilder::new();
    builder.move_to(x1, y1);
    builder.line_to(x2, y2);
    builder.finish()
}

fn color(r: u8, g: u8, b: u8, a: f32) -> Option<Color> {
    Color::from_rgba(
        r as f32 / 255.0,
        g as f32 / 255.0,
        b as f32 / 255.0,
        a,
    )
}

fn fill_path(pixmap: &mut Pixmap, path: &tiny_skia::Path, paint_color: Color) {
    let mut paint = Paint::default();
    paint.anti_alias = true;
    paint.shader = Shader::SolidColor(paint_color);
    pixmap.fill_path(
        path,
        &paint,
        FillRule::Winding,
        Transform::identity(),
        None,
    );
}

fn stroke_path(pixmap: &mut Pixmap, path: &tiny_skia::Path, paint_color: Color, width: f32) {
    let mut paint = Paint::default();
    paint.anti_alias = true;
    paint.shader = Shader::SolidColor(paint_color);
    let stroke = Stroke {
        width,
        line_cap: LineCap::Round,
        line_join: LineJoin::Round,
        ..Stroke::default()
    };
    pixmap.stroke_path(path, &paint, &stroke, Transform::identity(), None);
}

/// tiny-skia 输出是预乘 RGBA，转成 tauri Image 需要的直通 RGBA
fn pixmap_to_image(pixmap: &Pixmap) -> tauri::image::Image<'static> {
    let mut rgba = Vec::with_capacity(pixmap.data().len());
    for pixel in pixmap.data().chunks_exact(4) {
        let [r, g, b, a] = [pixel[0] as u32, pixel[1] as u32, pixel[2] as u32, pixel[3] as u32];
        if a == 0 {
            rgba.extend_from_slice(&[0, 0, 0, 0]);
        } else {
            rgba.push((((r * 255 + a / 2) / a).min(255)) as u8);
            rgba.push((((g * 255 + a / 2) / a).min(255)) as u8);
            rgba.push((((b * 255 + a / 2) / a).min(255)) as u8);
            rgba.push(a as u8);
        }
    }
    tauri::image::Image::new_owned(rgba, pixmap.width(), pixmap.height())
}

// ─── 速览面板锚定 ───

/// 由托盘图标位置推导 glance 窗口摆放位置（物理像素）。
/// 图标位于工作区顶部（macOS 菜单栏）→ 面板置于其下；否则（Windows/Linux 托盘常在底部）
/// → 置于其上；水平方向以图标中心对齐并钳制在工作区内。坐标不可靠（如部分 Linux DE）时返回 None。
pub fn anchor_position(
    window: &tauri::WebviewWindow,
    cursor: (f64, f64),
    icon: (f64, f64, f64, f64),
) -> Option<tauri::PhysicalPosition<i32>> {
    let (icon_x, icon_y, icon_w, icon_h) = icon;
    if icon_w <= 0.0 || icon_h <= 0.0 {
        return None;
    }
    let monitors = window.available_monitors().ok()?;
    let work = monitors
        .iter()
        .find(|monitor| monitor_contains(monitor, cursor))
        .map(work_rect)
        .or_else(|| window.current_monitor().ok().flatten().map(|monitor| work_rect(&monitor)))?;
    let win_size = window.outer_size().ok()?;
    let margin = 8.0;
    let (win_w, win_h) = (win_size.width as f64, win_size.height as f64);
    let (work_x, work_y, work_w, work_h) = work;

    let icon_center_x = icon_x + icon_w / 2.0;
    let below = icon_y < work_y + work_h * 0.25;
    let x = (icon_center_x - win_w / 2.0).clamp(
        work_x + margin,
        (work_x + work_w - win_w - margin).max(work_x + margin),
    );
    let y = if below {
        icon_y + icon_h + margin
    } else {
        icon_y - win_h - margin
    };
    let y = y.clamp(
        work_y + margin,
        (work_y + work_h - win_h - margin).max(work_y + margin),
    );
    Some(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32))
}

fn monitor_contains(monitor: &tauri::Monitor, cursor: (f64, f64)) -> bool {
    let (mx, my) = (monitor.position().x as f64, monitor.position().y as f64);
    let (mw, mh) = (monitor.size().width as f64, monitor.size().height as f64);
    cursor.0 >= mx && cursor.0 < mx + mw && cursor.1 >= my && cursor.1 < my + mh
}

fn work_rect(monitor: &tauri::Monitor) -> (f64, f64, f64, f64) {
    let work = monitor.work_area();
    (
        work.position.x as f64,
        work.position.y as f64,
        work.size.width as f64,
        work.size.height as f64,
    )
}

/// glance 窗口隐藏后 300ms 内的托盘单击视为 blur 自动隐藏的同一交互，不重新弹出
pub const GLANCE_RESHOW_GUARD: Duration = Duration::from_millis(300);

// ─── 命令 ───

/// 切换托盘图标呈现方案（设置页调用，切换即生效）
#[tauri::command]
pub fn set_tray_icon_scheme(app: tauri::AppHandle, scheme: String) -> Result<(), String> {
    let parsed = TrayScheme::parse(&scheme).ok_or_else(|| format!("未知托盘图标方案：{scheme}"))?;
    let state = app.state::<TrayState>();
    *state.scheme.lock().expect("tray scheme lock poisoned") = parsed;
    apply(&app);
    Ok(())
}

/// 推送计量快照（主窗口在刷新完成/告警态变化时调用，是托盘呈现的唯一数据写入方）。
/// ring_windows（ADR-0017）：环层序百分比（外→内 = 周期短→长，前端取最紧三扇），
/// 缺省时回退 ring_percent 单层。badge_percent（ADR-0020）：数字标题 = 最紧窗口已用
/// 百分比，由前端显式传递，与环层序解耦。
#[tauri::command]
pub fn update_tray_meter(
    app: tauri::AppHandle,
    ring_percent: Option<f64>,
    ring_windows: Option<Vec<f64>>,
    badge_percent: Option<f64>,
    bar_top: Option<f64>,
    bar_bottom: Option<f64>,
    alert: bool,
    summary: Option<String>,
    language: Option<String>,
) -> Result<(), String> {
    let state = app.state::<TrayState>();
    {
        let mut meter = state.meter.lock().expect("tray meter lock poisoned");
        *meter = Some(TrayMeter {
            ring_percent,
            // 防御性规整：只取前三层、丢弃非有限值（正常路径前端已保证）
            ring_windows: ring_windows
                .unwrap_or_default()
                .into_iter()
                .filter(|value| value.is_finite())
                .take(RING_LAYERS_MAX)
                .collect(),
            badge_percent,
            bar_top,
            bar_bottom,
            alert,
            // tooltip Windows 上限 127 字符，摘要超长直接丢弃（前端通常已截断）
            summary: summary.filter(|text| !text.is_empty()).map(|text| text.chars().take(80).collect()),
        });
    }
    if let Some(language) = language {
        *state.language.lock().expect("tray language lock poisoned") = language;
    }
    apply(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 复算 draw_usage_bars 的几何参数，避免测试里重复写魔数
    fn bar_metrics(size: u32) -> (f32, f32) {
        let s = size as f32;
        ((s * 0.20).max(2.0), s * 0.68)
    }

    /// 不透明计量色像素所在的连续行区段（闭区间），自左向右扫描时按行聚合
    fn fill_row_bands(image: &tauri::image::Image<'static>) -> Vec<(u32, u32)> {
        let (w, h) = (image.width(), image.height());
        let rgba = image.rgba();
        let (r, g, b) = meter_color(false);
        let mut bands = Vec::new();
        let mut start: Option<u32> = None;
        for y in 0..h {
            let mut hit = false;
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                if rgba[i + 3] < 250 {
                    continue;
                }
                if rgba[i].abs_diff(r) <= 8 && rgba[i + 1].abs_diff(g) <= 8 && rgba[i + 2].abs_diff(b) <= 8 {
                    hit = true;
                    break;
                }
            }
            match (start, hit) {
                (None, true) => start = Some(y),
                (Some(from), false) => {
                    bands.push((from, y - 1));
                    start = None;
                }
                _ => {}
            }
        }
        if let Some(from) = start {
            bands.push((from, h - 1));
        }
        bands
    }

    /// 不透明计量色像素的横向跨度（None = 没有填充）
    fn fill_column_span(image: &tauri::image::Image<'static>) -> Option<(u32, u32)> {
        let (w, h) = (image.width(), image.height());
        let rgba = image.rgba();
        let (r, g, b) = meter_color(false);
        let mut min = None::<u32>;
        let mut max = None::<u32>;
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                if rgba[i + 3] < 250 {
                    continue;
                }
                if rgba[i].abs_diff(r) <= 8 && rgba[i + 1].abs_diff(g) <= 8 && rgba[i + 2].abs_diff(b) <= 8 {
                    min = Some(min.map_or(x, |v: u32| v.min(x)));
                    max = Some(max.map_or(x, |v: u32| v.max(x)));
                }
            }
        }
        match (min, max) {
            (Some(lo), Some(hi)) => Some((lo, hi)),
            _ => None,
        }
    }

    /// 回归用例：core < 1px 的退化分支曾经用「描边圆」画左端点，得到直径 2×条厚的胖圆点。
    /// 各尺寸档 × 低百分比下，填充的竖向厚度都不得超过条厚（抗锯齿留 2px 余量）。
    #[test]
    fn low_percent_fill_keeps_bar_thickness() {
        for size in [16u32, 20, 24, 32] {
            let (bar_height, _) = bar_metrics(size);
            for percent in [0.5f64, 1.0, 2.0, 4.0, 8.0, 9.0, 20.0, 60.0, 100.0] {
                let image = draw_usage_bars(size, percent, None, false)
                    .unwrap_or_else(|| panic!("size={size} percent={percent} 渲染失败"));
                let bands = fill_row_bands(&image);
                assert_eq!(bands.len(), 1, "size={size} percent={percent} 应只有一条填充");
                let thickness = (bands[0].1 - bands[0].0 + 1) as f32;
                assert!(
                    thickness <= bar_height + 2.0,
                    "size={size} percent={percent}：填充厚度 {thickness} 超过条厚 {bar_height}",
                );
            }
        }
    }

    /// 双条同粗：上条（低进度）与下条（满格）的厚度必须一致
    #[test]
    fn two_bars_share_same_thickness() {
        for size in [16u32, 20, 24, 32] {
            let image = draw_usage_bars(size, 3.0, Some(100.0), false)
                .unwrap_or_else(|| panic!("size={size} 渲染失败"));
            let bands = fill_row_bands(&image);
            assert_eq!(bands.len(), 2, "size={size} 应有上下两条填充，实际 {bands:?}");
            let top = bands[0].1 - bands[0].0 + 1;
            let bottom = bands[1].1 - bands[1].0 + 1;
            assert!(
                top.abs_diff(bottom) <= 2,
                "size={size}：上条厚度 {top} 与下条厚度 {bottom} 不一致",
            );
        }
    }

    /// 满格时填充横向铺满整条胶囊（含两端圆头）
    #[test]
    fn full_bar_spans_bar_length() {
        for size in [16u32, 20, 24, 32] {
            let (_, bar_length) = bar_metrics(size);
            let image = draw_usage_bars(size, 100.0, None, false)
                .unwrap_or_else(|| panic!("size={size} 渲染失败"));
            let (lo, hi) = fill_column_span(&image).expect("满格应有填充");
            let span = (hi - lo + 1) as f32;
            assert!(
                (span - bar_length).abs() <= 2.0,
                "size={size}：填充跨度 {span} 与条长 {bar_length} 不符",
            );
        }
    }

    /// 0% 不画填充，只留轨道
    #[test]
    fn zero_percent_draws_no_fill() {
        let image = draw_usage_bars(24, 0.0, None, false).expect("渲染失败");
        assert!(fill_row_bands(&image).is_empty(), "0% 不应有填充像素");
    }

    /// 复刻修复前的退化分支（core < 1px 时对圆路径做 width=bar_height 的描边），
    /// 仅用于人工对比预览，几何与 draw_usage_bars 保持一致；改几何时需同步。
    fn draw_usage_bars_old_bug(size: u32, top: f64, bottom: Option<f64>, alert: bool) -> Option<Pixmap> {
        let mut pixmap = Pixmap::new(size, size)?;
        let s = size as f32;
        let bar_height = (s * 0.20).max(2.0);
        let bar_length = s * 0.68;
        let gap = s * 0.14;
        let left = (s - bar_length) / 2.0;
        let right = left + bar_length;
        let cap_radius = bar_height / 2.0;

        let percents: Vec<f64> = match bottom {
            Some(value) => vec![top, value],
            None => vec![top],
        };
        let total_height = bar_height * percents.len() as f32 + gap * (percents.len() as f32 - 1.0);
        let mut center_y = (s - total_height) / 2.0 + cap_radius;

        for percent in percents {
            let track = line_path(left + cap_radius, center_y, right - cap_radius, center_y)?;
            stroke_path(
                &mut pixmap,
                &track,
                color(
                    RING_COLOR_TRACK.0,
                    RING_COLOR_TRACK.1,
                    RING_COLOR_TRACK.2,
                    RING_COLOR_TRACK.3,
                )?,
                bar_height,
            );

            let fraction = (percent / 100.0).clamp(0.0, 1.0);
            if fraction > f64::EPSILON {
                let core = (bar_length - bar_height) * fraction as f32;
                let (r, g, b) = meter_color(alert);
                let paint = color(r, g, b, 1.0)?;
                if core < 1.0 {
                    // 修复前：描边圆 → 外半径 cap_radius + bar_height/2 = bar_height，胖圆点
                    stroke_path(
                        &mut pixmap,
                        &PathBuilder::from_circle(left + cap_radius, center_y, cap_radius)?,
                        paint,
                        bar_height,
                    );
                } else {
                    stroke_path(
                        &mut pixmap,
                        &line_path(left + cap_radius, center_y, left + cap_radius + core, center_y)?,
                        paint,
                        bar_height,
                    );
                }
            }
            center_y += bar_height + gap;
        }
        Some(pixmap)
    }

    /// 最近邻放大（托盘原图只有 16~32px，直接看不清）
    fn upscale_png(pixmap: &Pixmap, factor: u32) -> Pixmap {
        let mut out =
            Pixmap::new(pixmap.width() * factor, pixmap.height() * factor).expect("放大画布创建失败");
        let out_width = out.width();
        for y in 0..pixmap.height() {
            for x in 0..pixmap.width() {
                let Some(px) = pixmap.pixel(x, y) else { continue };
                for dy in 0..factor {
                    for dx in 0..factor {
                        out.pixels_mut()
                            [((y * factor + dy) * out_width + x * factor + dx) as usize] = px;
                    }
                }
            }
        }
        out
    }

    /// 复刻多层化之前的单环实现（ADR-0016 几何：stroke=max(0.15s,2)、外缘留 2% 边距），
    /// 用于锁定 ADR-0017 的「单层与旧版像素级一致」承诺；仅测试可见。
    fn draw_usage_ring_legacy(size: u32, percent: f64, alert: bool) -> Option<tauri::image::Image<'static>> {
        let mut pixmap = Pixmap::new(size, size)?;
        let s = size as f32;
        let stroke_width = (s * 0.15).max(2.0);
        let radius = (s - stroke_width) / 2.0 - s * 0.02;
        let (cx, cy) = (s / 2.0, s / 2.0);

        stroke_path(
            &mut pixmap,
            &PathBuilder::from_circle(cx, cy, radius)?,
            color(RING_COLOR_TRACK.0, RING_COLOR_TRACK.1, RING_COLOR_TRACK.2, RING_COLOR_TRACK.3)?,
            stroke_width,
        );

        let fraction = (percent / 100.0).clamp(0.0, 1.0);
        if fraction > f64::EPSILON {
            let sweep = (fraction * 360.0).min(359.6) as f32;
            let steps = ((sweep / 5.0).ceil() as usize).max(2);
            let mut builder = PathBuilder::new();
            for i in 0..=steps {
                let angle = (-90.0_f32 + sweep * (i as f32 / steps as f32)).to_radians();
                let (x, y) = (cx + radius * angle.cos(), cy + radius * angle.sin());
                if i == 0 {
                    builder.move_to(x, y);
                } else {
                    builder.line_to(x, y);
                }
            }
            if let Some(path) = builder.finish() {
                let (r, g, b) = meter_color(alert);
                stroke_path(&mut pixmap, &path, color(r, g, b, 1.0)?, stroke_width);
            }
        }

        Some(pixmap_to_image(&pixmap))
    }

    /// 像素是否为不透明计量色（品牌色；±8 容差抗 AA 混色，alpha≥250 排除半透明轨道/边缘）
    fn is_meter_pixel(image: &tauri::image::Image<'static>, x: u32, y: u32) -> bool {
        let w = image.width();
        let rgba = image.rgba();
        let i = ((y * w + x) * 4) as usize;
        if rgba[i + 3] < 250 {
            return false;
        }
        let (r, g, b) = meter_color(false);
        rgba[i].abs_diff(r) <= 8 && rgba[i + 1].abs_diff(g) <= 8 && rgba[i + 2].abs_diff(b) <= 8
    }

    /// 行 y 在 [x_from, x_to] 内的计量色连续列段（闭区间列表）
    fn meter_bands_in_row(
        image: &tauri::image::Image<'static>,
        y: u32,
        x_from: u32,
        x_to: u32,
    ) -> Vec<(u32, u32)> {
        let mut bands = Vec::new();
        let mut start: Option<u32> = None;
        for x in x_from..=x_to {
            let hit = is_meter_pixel(image, x, y);
            match (start, hit) {
                (None, true) => start = Some(x),
                (Some(from), false) => {
                    bands.push((from, x - 1));
                    start = None;
                }
                _ => {}
            }
        }
        if let Some(from) = start {
            bands.push((from, x_to));
        }
        bands
    }

    /// 列 x 在 [y_from, y_to] 内的计量色连续行段（闭区间列表）
    fn meter_bands_in_column(
        image: &tauri::image::Image<'static>,
        x: u32,
        y_from: u32,
        y_to: u32,
    ) -> Vec<(u32, u32)> {
        let mut bands = Vec::new();
        let mut start: Option<u32> = None;
        for y in y_from..=y_to {
            let hit = is_meter_pixel(image, x, y);
            match (start, hit) {
                (None, true) => start = Some(y),
                (Some(from), false) => {
                    bands.push((from, y - 1));
                    start = None;
                }
                _ => {}
            }
        }
        if let Some(from) = start {
            bands.push((from, y_to));
        }
        bands
    }

    fn has_meter_pixel(image: &tauri::image::Image<'static>) -> bool {
        let (w, h) = (image.width(), image.height());
        (0..h).any(|y| (0..w).any(|x| is_meter_pixel(image, x, y)))
    }

    /// 计量色像素外接框 (min_x, min_y, max_x, max_y)
    fn meter_pixel_bounds(image: &tauri::image::Image<'static>) -> Option<(u32, u32, u32, u32)> {
        let (w, h) = (image.width(), image.height());
        let mut bounds = None::<(u32, u32, u32, u32)>;
        for y in 0..h {
            for x in 0..w {
                if is_meter_pixel(image, x, y) {
                    bounds = Some(match bounds {
                        None => (x, y, x, y),
                        Some((min_x, min_y, max_x, max_y)) => {
                            (min_x.min(x), min_y.min(y), max_x.max(x), max_y.max(y))
                        }
                    });
                }
            }
        }
        bounds
    }

    /// 单层环必须与多层化前的旧实现逐像素一致（ADR-0017 承诺：旧形态即新环的单窗形态）
    #[test]
    fn single_layer_ring_matches_legacy_pixels() {
        for size in [16u32, 20, 24, 32] {
            for percent in [0.0f64, 4.0, 33.3, 50.0, 87.5, 100.0] {
                for alert in [false, true] {
                    let new_image = draw_usage_ring(size, &[percent], alert)
                        .unwrap_or_else(|| panic!("size={size} percent={percent} 渲染失败"));
                    let legacy = draw_usage_ring_legacy(size, percent, alert)
                        .unwrap_or_else(|| panic!("legacy size={size} 渲染失败"));
                    assert_eq!(
                        new_image.rgba(),
                        legacy.rgba(),
                        "size={size} percent={percent} alert={alert} 单层像素与旧实现不一致",
                    );
                }
            }
        }
    }

    /// 环层几何与 ADR-0017 定案一致：单层 = 旧公式；多层 = 16px 基准常量 × s/16
    #[test]
    fn ring_layer_specs_match_adr() {
        let single = ring_layer_specs(24, 1);
        assert_eq!(single.len(), 1);
        let s = 24.0f32;
        let stroke = (s * 0.15).max(2.0);
        assert!((single[0].1 - stroke).abs() < 1e-4);
        assert!((single[0].0 - ((s - stroke) / 2.0 - s * 0.02)).abs() < 1e-4);

        for (layers, table) in [
            (2usize, &RING_LAYERS_TWO[..]),
            (3, &RING_LAYERS_THREE[..]),
        ] {
            for size in [16u32, 20, 24, 32] {
                let specs = ring_layer_specs(size, layers);
                assert_eq!(specs.len(), layers, "size={size} layers={layers}");
                let scale = size as f32 / 16.0;
                for ((radius, stroke), (expect_r, expect_w)) in specs.iter().zip(table) {
                    assert!(
                        (radius - expect_r * scale).abs() < 1e-4
                            && (stroke - expect_w * scale).abs() < 1e-4,
                        "size={size} layers={layers}：几何 ({radius}, {stroke}) 偏离 ADR 基准",
                    );
                }
            }
        }
    }

    /// 多层带结构：50% 时沿 3 点方向（y=cy 行右半）扫描，各层各成一段
    /// （段数 = 层数，段间即层间间隙）、段厚 ≤ 层描边（防胖点回归）、段中心落在对应层半径上
    #[test]
    fn ring_layers_band_structure_at_half() {
        for size in [16u32, 20, 24, 32] {
            for layers in [1usize, 2, 3] {
                let percents: Vec<f64> = vec![50.0; layers];
                let image = draw_usage_ring(size, &percents, false)
                    .unwrap_or_else(|| panic!("size={size} layers={layers} 渲染失败"));
                let cy = size / 2;
                let cx = size as f32 / 2.0;
                let bands = meter_bands_in_row(&image, cy, cx as u32, size - 1);
                assert_eq!(
                    bands.len(),
                    layers,
                    "size={size} layers={layers}：3 点方向应有 {layers} 段，实际 {bands:?}",
                );
                let specs = ring_layer_specs(size, layers);
                // 行扫描自 x=cx 起向右 = 半径从小到大 = 内层→外层；specs 是外→内，反转配对
                for (band, (radius, stroke)) in bands.iter().rev().zip(&specs) {
                    let thickness = (band.1 - band.0 + 1) as f32;
                    assert!(
                        thickness <= stroke + 1.5,
                        "size={size} layers={layers}：段厚 {thickness} 超过描边 {stroke}",
                    );
                    let center = (band.0 as f32 + band.1 as f32) / 2.0 - cx;
                    assert!(
                        (center - radius).abs() <= 1.3,
                        "size={size} layers={layers}：段中心 {center} 偏离层半径 {radius}",
                    );
                }
            }
        }
    }

    /// 弧长-百分比映射（顶部起点顺时针）：0% 无填充；25% 仅 12→3 点（3 点方向有、9 点无、
    /// 6 点方向列下半无）；50% 仅右半圆；100% 铺满外环外缘
    #[test]
    fn ring_arc_percent_mapping() {
        for size in [16u32, 20, 24, 32] {
            let cx = size / 2;
            let cy = size / 2;

            let zero = draw_usage_ring(size, &[0.0], false).expect("渲染失败");
            assert!(!has_meter_pixel(&zero), "size={size}：0% 不应有计量色像素");

            let quarter = draw_usage_ring(size, &[25.0], false).expect("渲染失败");
            let left_empty = (0..cx).all(|x| !is_meter_pixel(&quarter, x, cy));
            assert!(left_empty, "size={size}：25% 时 y=cy 行左半不应有计量色");
            let right_filled = !meter_bands_in_row(&quarter, cy, cx, size - 1).is_empty();
            assert!(right_filled, "size={size}：25% 时 3 点方向应有计量色");
            // 25% 弧从 12 点顺时针到 3 点：x=cx 列上半有起点圆头、下半无弧
            let top_bands = meter_bands_in_column(&quarter, cx, 0, cy - 1);
            assert!(
                !top_bands.is_empty(),
                "size={size}：25% 时 12 点起点（x=cx 列上半）应有计量色",
            );
            let bottom_bands = meter_bands_in_column(&quarter, cx, cy + 1, size - 1);
            assert!(
                bottom_bands.is_empty(),
                "size={size}：25% 时 x=cx 列下半不应有计量色",
            );

            let half = draw_usage_ring(size, &[50.0], false).expect("渲染失败");
            let left_empty = (0..cx).all(|x| !is_meter_pixel(&half, x, cy));
            let right_filled = !meter_bands_in_row(&half, cy, cx, size - 1).is_empty();
            assert!(left_empty && right_filled, "size={size}：50% 应只覆盖右半圆");

            let full = draw_usage_ring(size, &[100.0], false).expect("渲染失败");
            let (radius, stroke) = ring_layer_specs(size, 1)[0];
            let expect_half_span = radius + stroke / 2.0;
            let (min_x, min_y, max_x, max_y) =
                meter_pixel_bounds(&full).expect("100% 应有计量色像素");
            let span_x = (max_x - min_x + 1) as f32;
            let span_y = (max_y - min_y + 1) as f32;
            assert!(
                (span_x - 2.0 * expect_half_span).abs() <= 2.5
                    && (span_y - 2.0 * expect_half_span).abs() <= 2.5,
                "size={size}：100% 外接框 {span_x}×{span_y} 偏离外环外缘 {}",
                2.0 * expect_half_span,
            );
        }
    }

    /// 环层数据解析：层数组优先，缺失回退单值，全缺为空（ADR-0017）
    #[test]
    fn ring_layer_percents_fallbacks() {
        assert_eq!(
            ring_layer_percents(&[10.0, 60.0, 30.0], Some(60.0)),
            vec![10.0, 60.0, 30.0],
        );
        assert_eq!(ring_layer_percents(&[], Some(42.0)), vec![42.0]);
        assert!(ring_layer_percents(&[], None).is_empty());
    }

    /// 呈现指纹（ADR-0019）：无变化时一个 setter 都不许被调用；任一字段变化只放行对应那一项。
    /// 回归背景：无谓重放会在 macOS 上整项重建状态项，肉眼表现为图标旁数字闪一下。
    #[test]
    fn presentation_changes_flags_only_dirty_parts() {
        let base = Presentation {
            icon: Some((16, 16, vec![0, 1, 2, 3])),
            title: "4".to_string(),
            tooltip: "AI 用量助手 — 5 小时请求配额（已用 4%）".to_string(),
        };

        // 首次应用：三件套全写
        assert_eq!(presentation_changes(None, &base), (true, true, true));
        // 内容一致：一项都不写
        assert_eq!(presentation_changes(Some(&base), &base), (false, false, false));

        let mut title = base.clone();
        title.title = "5".to_string();
        assert_eq!(presentation_changes(Some(&base), &title), (false, false, true));

        let mut tooltip = base.clone();
        tooltip.tooltip.push('。');
        assert_eq!(presentation_changes(Some(&base), &tooltip), (false, true, false));

        let mut icon = base.clone();
        icon.icon = Some((24, 24, vec![0, 1, 2, 3]));
        assert_eq!(presentation_changes(Some(&base), &icon), (true, false, false));

        // 图标同尺寸但像素不同（用量变化）也要放行
        let mut repainted = base.clone();
        repainted.icon = Some((16, 16, vec![9, 9, 9, 9]));
        assert_eq!(presentation_changes(Some(&base), &repainted), (true, false, false));
    }

    /// 数字标题（ADR-0020）：环方案取显式 badge_percent（最紧窗口已用百分比）取整；
    /// 非环方案是**空串**而不是「不设置」——tray-icon 0.24.2 的 `set_title(None)` 在 macOS
    /// 是空操作，传空串才能清掉切换方案后残留的旧数字。
    #[test]
    fn badge_text_follows_tightest_window() {
        assert_eq!(badge_text(TrayScheme::UsageRing, Some(4.4)), "4");
        assert_eq!(badge_text(TrayScheme::UsageRing, Some(99.6)), "100");
        assert_eq!(badge_text(TrayScheme::UsageRing, None), "");
        assert_eq!(badge_text(TrayScheme::Default, Some(4.4)), "");
        assert_eq!(badge_text(TrayScheme::UsageBars, Some(4.4)), "");
    }

    /// 手工预览工具：把「修复前 vs 修复后」的用量柱渲染成放大 PNG（ADR-0016 修复留档）。
    /// 运行：cargo test dump_tray_preview_pngs -- --ignored --nocapture
    /// 输出：<仓库根>/.workbuddy/tmp/tray-preview/
    #[test]
    #[ignore = "人工预览用：cargo test dump_tray_preview_pngs -- --ignored"]
    fn dump_tray_preview_pngs() {
        use std::path::Path;
        use tiny_skia::IntSize;

        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("无父目录")
            .join(".workbuddy/tmp/tray-preview");
        std::fs::create_dir_all(&root).expect("创建输出目录失败");

        // 模拟数据场景：top=上条（重置较近窗），bottom=下条（主指标）
        let cases: &[(&str, u32, f64, Option<f64>)] = &[
            ("24px_top4_bottom100", 24, 4.0, Some(100.0)), // 截图同款：5h≈4% + 周窗满
            ("24px_top9_bottom100", 24, 9.0, Some(100.0)), // 用户实测 9% 自愈档
            ("24px_top05_bottom60", 24, 0.5, Some(60.0)),  // 极低进度
            ("16px_top4_bottom100", 16, 4.0, Some(100.0)), // 最小尺寸档（旧版上下连体）
            ("32px_top4_bottom100", 32, 4.0, Some(100.0)), // 200% DPI 档
        ];
        for (name, size, top, bottom) in cases {
            let after = draw_usage_bars(*size, *top, *bottom, false).expect("渲染失败");
            let after_pixmap = Pixmap::from_vec(
                after.rgba().to_vec(),
                IntSize::from_wh(after.width(), after.height()).expect("尺寸非法"),
            )
            .expect("转 Pixmap 失败");
            upscale_png(&after_pixmap, 8)
                .save_png(root.join(format!("{name}_after.png")))
                .expect("保存 after PNG 失败");
            if let Some(old) = draw_usage_bars_old_bug(*size, *top, *bottom, false) {
                upscale_png(&old, 8)
                    .save_png(root.join(format!("{name}_before.png")))
                    .expect("保存 before PNG 失败");
            }
        }
    }

    /// 手工预览工具：把多层环（1/2/3 层 × 低/中/满百分比）渲染成放大 PNG。
    /// 运行：cargo test dump_tray_ring_preview_pngs -- --ignored --nocapture
    /// 输出：<仓库根>/.workbuddy/tmp/tray-preview/
    #[test]
    #[ignore = "人工预览用：cargo test dump_tray_ring_preview_pngs -- --ignored"]
    fn dump_tray_ring_preview_pngs() {
        use std::path::Path;
        use tiny_skia::IntSize;

        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("无父目录")
            .join(".workbuddy/tmp/tray-preview");
        std::fs::create_dir_all(&root).expect("创建输出目录失败");

        for size in [16u32, 24, 32] {
            for (layers, percents) in [
                (1usize, vec![4.0f64]),
                (1, vec![62.0]),
                (2, vec![4.0, 100.0]),
                (2, vec![62.0, 28.0]),
                (3, vec![4.0, 100.0, 12.0]),
                (3, vec![62.0, 28.0, 90.0]),
            ] {
                let image = draw_usage_ring(size, &percents, false).expect("渲染失败");
                let pixmap = Pixmap::from_vec(
                    image.rgba().to_vec(),
                    IntSize::from_wh(image.width(), image.height()).expect("尺寸非法"),
                )
                .expect("转 Pixmap 失败");
                let name = format!("{size}px_{}l_{}", layers, percents.iter().map(|p| p.to_string()).collect::<Vec<_>>().join("-"));
                upscale_png(&pixmap, 8)
                    .save_png(root.join(format!("ring_{name}.png")))
                    .expect("保存 PNG 失败");
            }
        }
    }
}
