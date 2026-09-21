/**
 * @vitest-environment jsdom
 *
 * 守护 StackedBars 顶部「架构铁律」：hover 只改 activeName，不得让 option 变新。
 * echarts-for-react 的 componentDidUpdate 用 fast-deep-equal 比较 option，而它对函数只比 ===，
 * 所以 option useMemo 一旦重算（tooltip.formatter 成为新闭包）就必然触发 setOption(notMerge)，
 * 销毁重建图形元素 → mouseout 不派发 → emphasis.focus='series' 的 blur 态卡死
 * （表现为鼠标移开后柱子持续变暗）。2026-09-21 定位：6c7ae0e 把未缓存的 useT() 返回值
 * 放进 option deps 触发了该回归，修复见 i18n useT 的 useCallback。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
// 与被测库同一份比较器，避免断言与实际判定口径漂移
import { isEqual } from "echarts-for-react/lib/helper/is-equal";

type ChartProps = {
  option: unknown;
  onEvents: Record<string, (e: unknown) => void>;
};
let captures: ChartProps[] = [];

vi.mock("echarts-for-react/lib/core", () => ({
  default: (props: ChartProps) => {
    captures.push(props);
    return null;
  },
}));

import { StackedBars } from "./StackedBars";

const series = [
  { name: "deepseek-v4-flash", values: [10, 0] },
  { name: "deepseek-chat", values: [0, 20] },
];
const yFormat = (v: number) => String(v);
const tooltipFormat = (v: number) => String(v);

/** 渲染后 hover 一次（mouseover 仅更新 activeName），返回前后 option 的比较结果 */
function hoverOnce(props: Record<string, unknown>) {
  captures = [];
  cleanup();
  render(<StackedBars labels={["09-20", "09-21"]} series={series} {...props} />);
  const before = captures[captures.length - 1];
  act(() => {
    before.onEvents.mouseover({ componentType: "series", seriesName: "deepseek-v4-flash" });
  });
  const after = captures[captures.length - 1];
  return {
    hovered: after !== before,
    sameRef: before.option === after.option,
    deepEqual: isEqual(before.option, after.option),
  };
}

afterEach(cleanup);

describe("StackedBars 架构铁律：hover 不触发 setOption", () => {
  it("调用方传入稳定格式化器时，hover 后 option 引用不变", () => {
    const result = hoverOnce({ yFormat, tooltipFormat });
    // 前置：确认 hover 确实触发了一次重渲染，否则断言会是假阳性
    expect(result.hovered).toBe(true);
    expect(result.sameRef).toBe(true);
    expect(result.deepEqual).toBe(true);
  });

  it("省略格式化器（走默认参数）时，hover 后 option 引用同样不变", () => {
    const result = hoverOnce({});
    expect(result.hovered).toBe(true);
    expect(result.sameRef).toBe(true);
    expect(result.deepEqual).toBe(true);
  });

  it("数据变化时 option 必须重算（反向守护：memo 不能过度稳定）", () => {
    captures = [];
    const view = render(<StackedBars labels={["09-20"]} series={[series[0]]} yFormat={yFormat} tooltipFormat={tooltipFormat} />);
    const before = captures[captures.length - 1];
    act(() => {
      view.rerender(
        <StackedBars
          labels={["09-20", "09-21"]}
          series={[...series]}
          yFormat={yFormat}
          tooltipFormat={tooltipFormat}
        />,
      );
    });
    const after = captures[captures.length - 1];
    expect(after).not.toBe(before);
    expect(isEqual(before.option, after.option)).toBe(false);
  });
});
