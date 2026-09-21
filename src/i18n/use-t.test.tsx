/**
 * @vitest-environment jsdom
 *
 * useT 必须按 language 缓存引用：未缓存时每次渲染都返回新箭头函数，任何把 t 放进
 * useMemo/useCallback 依赖的组件都会每渲染重算——图表侧即 echarts-for-react 判定 option
 * 变化并 setOption(notMerge) 重建，破坏 hover 态（回归案例见 ../components/charts/StackedBars.test.tsx）。
 */
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { act, render } from "@testing-library/react";
import { useT } from "./index";

describe("useT", () => {
  it("同一语言下跨渲染保持同一引用", () => {
    const refs: ((text: string) => string)[] = [];

    function Probe({ tick }: { tick: number }) {
      refs.push(useT());
      return <span>{tick}</span>;
    }

    function Host() {
      const [tick, setTick] = useState(0);
      return (
        <>
          <Probe tick={tick} />
          <button onClick={() => setTick((t) => t + 1)}>rerender</button>
        </>
      );
    }

    const view = render(<Host />);
    act(() => {
      view.getByRole("button").click();
    });

    expect(refs.length).toBe(2);
    expect(refs[0]).toBe(refs[1]);
  });
});
