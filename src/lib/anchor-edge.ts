export type SnappedEdge = "top" | "bottom" | null;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 贴边嗅探（ADR-0027）：窗口外框贴着所在显示器工作区的哪条边（全物理像素）。
 * 贴顶（macOS 菜单栏 / Windows 顶部任务栏）→ "top"，贴底（底部任务栏，含 Win11 溢出区
 * flyout 回退右下角）→ "bottom"，都不贴（Linux 左右栏、窗口被移动过、坐标不可靠）→ null，
 * 调用方此时只改尺寸不动坐标。阈值 = Rust 侧锚定间距(8px) + 取整与边框余量。
 */
export function snappedEdge(windowRect: Rect, workArea: Rect, threshold = 24): SnappedEdge {
  const nearTop = Math.abs(windowRect.y - workArea.y) <= threshold;
  const nearBottom =
    Math.abs(windowRect.y + windowRect.height - (workArea.y + workArea.height)) <= threshold;
  // 工作区过矮导致上下同贴时取 top：与「越界向工作区内钳制」的方向一致
  if (nearTop) return "top";
  if (nearBottom) return "bottom";
  return null;
}
