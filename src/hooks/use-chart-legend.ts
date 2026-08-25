import { useCallback, useEffect, useReducer } from "react";

/**
 * 图表图例状态（用于替代 ECharts 内置图例的自定义图例）。
 *
 * 设计原则：
 * 1. React state（selected 集合）是显隐的唯一来源；图表组件据此直接过滤
 *    series / data 数组，被取消勾选的系列从图表中物理移除（与 ECharts 原生图例一致）。
 * 2. 不再依赖 dispatchAction('legendToggleSelect') / option.legend.selected 这类
 *    在隐藏图例（show:false）下不可靠的方案。
 * 3. activeName 记录最近一次被选中的可见系列，用于 tooltip 高亮/置顶。
 */
export interface LegendState {
  /** 当前可见的系列名集合 */
  selected: Set<string>;
  /** 最近一次被选中的可见系列（tooltip 高亮目标） */
  activeName: string | null;
}

export type LegendAction =
  | { type: "toggle"; name: string }
  | { type: "reset"; names: string[] }
  | { type: "set-active"; name: string | null }
  | { type: "sync-selected"; selected: Record<string, boolean> };

export function initLegendState(names: string[]): LegendState {
  return { selected: new Set(names), activeName: null };
}

export function legendReducer(state: LegendState, action: LegendAction): LegendState {
  switch (action.type) {
    case "toggle": {
      const selected = new Set(state.selected);
      let activeName = state.activeName;
      if (selected.has(action.name)) {
        selected.delete(action.name);
      } else {
        selected.add(action.name);
        activeName = action.name;
      }
      if (activeName !== null && !selected.has(activeName)) {
        activeName = null;
      }
      return { selected, activeName };
    }
    case "reset":
      return initLegendState(action.names);
    case "set-active":
      return { ...state, activeName: action.name && state.selected.has(action.name) ? action.name : null };
    case "sync-selected": {
      const selected = new Set<string>();
      for (const [name, value] of Object.entries(action.selected)) {
        if (value) selected.add(name);
      }
      let activeName = state.activeName;
      if (activeName !== null && !selected.has(activeName)) {
        activeName = null;
      }
      return { selected, activeName };
    }
    default:
      return state;
  }
}

/** 把 Set 转成 ECharts 认识的 legend.selected 对象 */
export function buildSelectedMap(selected: Set<string>, allNames: string[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const name of allNames) {
    map[name] = selected.has(name);
  }
  return map;
}

export function useChartLegend(allNames: string[]) {
  const namesKey = allNames.join("\0");
  const [state, dispatch] = useReducer(legendReducer, allNames, initLegendState);

  useEffect(() => {
    dispatch({ type: "reset", names: allNames });
  }, [namesKey]);

  const toggle = useCallback((name: string) => {
    dispatch({ type: "toggle", name });
  }, []);

  const setActive = useCallback((name: string | null) => {
    dispatch({ type: "set-active", name });
  }, []);

  const syncSelected = useCallback((selected: Record<string, boolean>) => {
    dispatch({ type: "sync-selected", selected });
  }, []);

  return {
    selected: state.selected,
    activeName: state.activeName,
    toggle,
    setActive,
    syncSelected,
    isSelected: useCallback((name: string) => state.selected.has(name), [state.selected]),
    isActive: useCallback((name: string) => state.activeName === name, [state.activeName]),
  };
}
