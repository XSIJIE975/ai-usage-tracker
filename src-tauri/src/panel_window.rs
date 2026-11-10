//! 面板窗口（快速面板 / 速览面板）唤出前的显示状态修复（ADR-0045）。
//!
//! 病根：两个面板窗口启动即创建且隐藏（`visible: false`），物理尺寸按「创建那一刻」
//! 的缩放比换算定死。Windows 不给隐藏窗口投递 `WM_DPICHANGED`，显示设置（缩放比例）
//! 变化后窗口缓存 scale 与 WebView2 内容视口一起停在旧值——唤出时内容按旧缩放排版，
//! 被新物理尺寸的窗口裁掉（右侧截断）；分辨率改小或显示器被拔后，窗口坐标也可能落
//! 在屏幕外，右半截不可见甚至整只唤不出来。重启即恢复（物理尺寸重新按当前缩放换算），
//! 印证是运行时状态过期而非任何持久化损坏。
//!
//! 修复选在「每次唤出前」幂等修复而非监听显示变化实时维护：显示变化对隐藏窗口没有
//! 可靠事件可听，唤出是唯一确定需要窗口处于正确状态的时机。缩放比变化时此处的
//! `set_size` 物理尺寸真实变化，产生的 WM_SIZE 同时逼 WebView2 按新 DPI 重排。

use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

/// 与窗口标签对应的两个常驻面板窗口；`ScaleFactorChanged` 收尾修复只认它们
pub const PANEL_LABELS: [&str; 2] = ["quick", "glance"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

/// 唤出前修复窗口矩形（幂等，无变化不产生任何窗口调用）：
/// 1. 目标显示器 = 与窗口当前矩形相交面积最大者（保留用户拖动位置，越界才钳回）；
///    全部不相交（显示器被拔等）时退光标所在显示器，再退第一个显示器。
/// 2. 物理尺寸按「当前逻辑尺寸 × 目标显示器 scale」重算。当前逻辑尺寸 = 当前物理尺寸
///    ÷ 窗口缓存 scale——缓存 scale 恒与当前物理尺寸同代（每次物理尺寸落笔都用的当时
///    缓存值；隐藏窗口收不到 DPI 消息，显示设置变化后二者一起过期，比值仍是逻辑尺寸）。
///    ADR-0027 同款教训：换算必须用目标显示器的 scale，不能信窗口缓存值。
/// 3. 位置钳回目标显示器工作区（面板比工作区还大时贴工作区左/上缘）。
///
/// 任一查询失败即整体放弃，走原样 show（修复只在可用时生效，不阻断唤出）。
pub fn ensure_on_screen(window: &WebviewWindow) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    if monitors.is_empty() {
        return;
    }
    let cursor = window.cursor_position().ok().map(|position| (position.x, position.y));

    let bounds: Vec<Rect> = monitors
        .iter()
        .map(|monitor| Rect {
            x: monitor.position().x,
            y: monitor.position().y,
            w: monitor.size().width as i32,
            h: monitor.size().height as i32,
        })
        .collect();
    let current = Rect {
        x: position.x,
        y: position.y,
        w: size.width as i32,
        h: size.height as i32,
    };
    let Some(index) = pick_target_rect(current, &bounds, cursor) else {
        return;
    };
    let target = &monitors[index];

    let (new_width, new_height) = rescaled_size((size.width, size.height), scale, target.scale_factor());
    let work = target.work_area();
    let work_rect = Rect {
        x: work.position.x,
        y: work.position.y,
        w: work.size.width as i32,
        h: work.size.height as i32,
    };
    let (new_x, new_y) = clamped_position((position.x, position.y), (new_width, new_height), work_rect);

    if (new_width, new_height) != (size.width, size.height) {
        let _ = window.set_size(PhysicalSize::new(new_width, new_height));
    }
    if (new_x, new_y) != (position.x, position.y) {
        let _ = window.set_position(PhysicalPosition::new(new_x, new_y));
    }
}

/// 两矩形的相交面积（i64 乘积避免大坐标溢出；相切/相离返回 0）
fn intersection_area(a: Rect, b: Rect) -> i64 {
    let overlap_w = (a.x + a.w).min(b.x + b.w) - a.x.max(b.x);
    let overlap_h = (a.y + a.h).min(b.y + b.h) - a.y.max(b.y);
    i64::from(overlap_w.max(0)) * i64::from(overlap_h.max(0))
}

/// 唤出目标显示器：相交面积最大的优先（平局取先出现的，确定性）；
/// 全不相交时选包含光标的显示器；光标不可得或也不在任何屏内退第一个。
fn pick_target_rect(current: Rect, monitors: &[Rect], cursor: Option<(f64, f64)>) -> Option<usize> {
    let mut best: Option<(usize, i64)> = None;
    for (index, rect) in monitors.iter().enumerate() {
        let area = intersection_area(current, *rect);
        if area > 0 && best.map_or(true, |(_, best_area)| area > best_area) {
            best = Some((index, area));
        }
    }
    if let Some((index, _)) = best {
        return Some(index);
    }
    if let Some((cursor_x, cursor_y)) = cursor {
        let contains = |rect: &Rect| {
            f64::from(rect.x) <= cursor_x
                && cursor_x < f64::from(rect.x + rect.w)
                && f64::from(rect.y) <= cursor_y
                && cursor_y < f64::from(rect.y + rect.h)
        };
        if let Some(index) = monitors.iter().position(contains) {
            return Some(index);
        }
    }
    if monitors.is_empty() {
        None
    } else {
        Some(0)
    }
}

/// 物理尺寸跨缩放比重算：先还原逻辑尺寸再乘目标 scale，四舍五入。
/// 源 scale 非法或两 scale 相同则原值返回（此时换算是恒等，无谓的 set_size 只会引入抖动）。
fn rescaled_size(size: (u32, u32), from_scale: f64, to_scale: f64) -> (u32, u32) {
    if from_scale <= 0.0 || (from_scale - to_scale).abs() < f64::EPSILON {
        return size;
    }
    let convert = |value: u32| (f64::from(value) / from_scale * to_scale).round() as u32;
    (convert(size.0), convert(size.1))
}

/// 位置钳回工作区：未越界一个像素不动；面板比工作区还宽/高时贴工作区左/上缘
/// （与 tray_scheme::compute_anchor 的钳制手法一致）
fn clamped_position(pos: (i32, i32), size: (u32, u32), work: Rect) -> (i32, i32) {
    let (w, h) = (i32::try_from(size.0).unwrap_or(i32::MAX), i32::try_from(size.1).unwrap_or(i32::MAX));
    let x = pos.0.clamp(work.x, (work.x + work.w - w).max(work.x));
    let y = pos.1.clamp(work.y, (work.y + work.h - h).max(work.y));
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, w: i32, h: i32) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn 相交面积_重叠相离相切() {
        let a = rect(0, 0, 100, 100);
        // 重叠 50×50
        assert_eq!(intersection_area(a, rect(50, 50, 100, 100)), 2500);
        // 相离
        assert_eq!(intersection_area(a, rect(200, 0, 50, 50)), 0);
        // 边缘相切（零重叠不算在屏内）
        assert_eq!(intersection_area(a, rect(100, 0, 50, 50)), 0);
        // 完全包含取小者
        assert_eq!(intersection_area(a, rect(10, 10, 10, 10)), 100);
    }

    #[test]
    fn 目标显示器_取相交面积最大者() {
        let monitors = [rect(0, 0, 1920, 1080), rect(1920, 0, 2560, 1440)];
        // 窗口跨两屏：落面积大的那屏（1700..2200 与屏0交 220、与屏1交 280 → 屏1）
        let current = rect(1700, 0, 500, 400);
        assert_eq!(pick_target_rect(current, &monitors, None), Some(1));
        // 大部在屏0
        let current = rect(1400, 0, 500, 400);
        assert_eq!(pick_target_rect(current, &monitors, None), Some(0));
        // 平局取先出现的
        let current = rect(1870, 0, 100, 100);
        assert_eq!(pick_target_rect(current, &monitors, None), Some(0));
    }

    #[test]
    fn 目标显示器_全出屏退光标所在屏再退第一个() {
        let monitors = [rect(0, 0, 1920, 1080), rect(1920, 0, 2560, 1440)];
        // 窗口整体在屏外：光标在第二屏 → 第二屏
        let current = rect(10000, 5000, 570, 480);
        assert_eq!(pick_target_rect(current, &monitors, Some((2500.0, 100.0))), Some(1));
        // 光标也不在任何屏内 → 第一个
        assert_eq!(pick_target_rect(current, &monitors, Some((-500.0, -500.0))), Some(0));
        // 光标不可得 → 第一个
        assert_eq!(pick_target_rect(current, &monitors, None), Some(0));
        // 无显示器可选 → None
        assert_eq!(pick_target_rect(current, &[], None), None);
    }

    #[test]
    fn 尺寸跨缩放比重算() {
        // 150% 创建的 380×320 → 570×480 物理；降到 100% 应回到 380×320
        assert_eq!(rescaled_size((570, 480), 1.5, 1.0), (380, 320));
        // 反向：100% 的 380×320 升到 150% 应放大到 570×480
        assert_eq!(rescaled_size((380, 320), 1.0, 1.5), (570, 480));
        // 125% ↔ 150% 四舍五入
        assert_eq!(rescaled_size((475, 400), 1.25, 1.5), (570, 480));
        // 同 scale 原值返回
        assert_eq!(rescaled_size((570, 480), 1.5, 1.5), (570, 480));
        // 源 scale 非法不换算
        assert_eq!(rescaled_size((570, 480), 0.0, 1.0), (570, 480));
    }

    #[test]
    fn 位置钳回工作区() {
        let work = rect(0, 0, 1920, 1040);
        // 未越界一个像素不动
        assert_eq!(clamped_position((100, 100), (570, 480), work), (100, 100));
        // 右/下越界拉回工作区内
        assert_eq!(clamped_position((1800, 900), (570, 480), work), (1350, 560));
        // 整体在屏外（负坐标/远超右下）拉回工作区左上附近
        assert_eq!(clamped_position((-2000, -2000), (570, 480), work), (0, 0));
        assert_eq!(clamped_position((9000, 9000), (570, 480), work), (1350, 560));
        // 面板比工作区还大：贴工作区左/上缘
        let small = rect(100, 100, 400, 300);
        assert_eq!(clamped_position((0, 0), (1920, 1040), small), (100, 100));
        // 非零原点工作区（副屏在右侧）同样成立
        let side = rect(1920, 0, 2560, 1400);
        assert_eq!(clamped_position((100, 100), (570, 480), side), (1920, 100));
    }
}
