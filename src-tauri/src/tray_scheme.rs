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
    /// 环/macOS 数字展示的已用百分比（选中实例的最紧窗口，全部窗口的最大值）；None = 无可绘数据
    pub ring_percent: Option<f64>,
    /// 柱的上条（已用%最高两窗中重置较近的）；None = 无柱可绘
    pub bar_top: Option<f64>,
    /// 柱的下条（重置较远的）；None = 上条单条居中
    pub bar_bottom: Option<f64>,
    /// 任一实例处于活跃告警（含余额告警），计量方案强制红
    pub alert: bool,
    /// 已本地化的多行摘要（首行实例名，其后每窗一行），用于动态 tooltip
    pub summary: Option<String>,
}

/// 托盘呈现的共享状态：方案、计量快照、界面语言与 glance 隐藏时刻（blur 竞态判定）
#[derive(Default)]
pub struct TrayState {
    pub scheme: Mutex<TrayScheme>,
    pub meter: Mutex<Option<TrayMeter>>,
    pub language: Mutex<String>,
    pub glance_hidden_at: Mutex<Option<Instant>>,
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
        return tray_tooltip(language, true).to_string();
    }
    let title = tray_tooltip(language, false);
    match meter.and_then(|meter| meter.summary.as_deref()) {
        Some(summary) if !summary.is_empty() => {
            // Windows 托盘 tooltip 仅识别 CRLF 换行，多行摘要（每条配额窗口一行）需转换
            #[cfg(target_os = "windows")]
            let summary = summary.replace('\n', "\r\n");
            format!("{title} — {summary}")
        }
        _ => title.to_string(),
    }
}

/// 按当前方案与计量快照重放托盘呈现（图标 + tooltip + macOS 标题）。
/// 切换方案、推送计量、语言变化、DPI 变化后都要调一次。
pub fn apply(app: &tauri::AppHandle) {
    let Some(tray) = app.tray_by_id("main-tray") else {
        return;
    };
    let state = app.state::<TrayState>();
    let scheme = *state.scheme.lock().expect("tray scheme lock poisoned");
    let meter = state.meter();
    let language = state.language();

    let alert = meter.as_ref().is_some_and(|meter| meter.alert);
    let ring_percent = meter.as_ref().and_then(|meter| meter.ring_percent);
    let bar_top = meter.as_ref().and_then(|meter| meter.bar_top);
    let bar_bottom = meter.as_ref().and_then(|meter| meter.bar_bottom);

    // 图标按主窗口 DPI 档位绘制（100%→16px、125%→20px、150%→24px、200%→32px）
    let scale = app
        .get_webview_window("main")
        .and_then(|window| window.scale_factor().ok())
        .unwrap_or(1.0);
    let size = ((16.0 * scale).round() as u32).clamp(16, 32);

    let icon = match (scheme, ring_percent, bar_top) {
        (TrayScheme::UsageRing, Some(percent), _) => {
            draw_usage_ring(size, percent, alert).unwrap_or_else(|| fallback_icon(app, alert))
        }
        (TrayScheme::UsageBars, _, Some(top)) => {
            draw_usage_bars(size, top, bar_bottom, alert)
                .unwrap_or_else(|| fallback_icon(app, alert))
        }
        _ => fallback_icon(app, alert),
    };
    let _ = tray.set_icon(Some(icon));
    let _ = tray.set_tooltip(Some(tooltip_text(&language, meter.as_ref())));
    // macOS 在图标旁显示最紧窗口的百分比文本；Windows/Linux 为空实现（ADR-0016）
    let badge = match (scheme, ring_percent) {
        (TrayScheme::UsageRing, Some(percent)) => Some(format!("{}", percent.round())),
        _ => None,
    };
    let _ = tray.set_title(badge.as_deref());
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

/// 绘制用量环：灰色轨道 + 按百分比的进度弧（顶部起点、圆角端点），告警时整环红色
fn draw_usage_ring(size: u32, percent: f64, alert: bool) -> Option<tauri::image::Image<'static>> {
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
            stroke_path(&mut pixmap, &path, color(r, g, b, 1.0)?, stroke_width);
        }
    }

    Some(pixmap_to_image(&pixmap))
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

/// 推送计量快照（主窗口在刷新完成/告警态变化时调用，是托盘呈现的唯一数据写入方）
#[tauri::command]
pub fn update_tray_meter(
    app: tauri::AppHandle,
    ring_percent: Option<f64>,
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

    /// 手工预览工具：把「修复前 vs 修复后」的用量柱渲染成放大 PNG。
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
}
