import { describe, expect, it } from "vitest";
import { initLegendState, legendReducer, buildSelectedMap } from "./use-chart-legend";

describe("legendReducer", () => {
  it("initializes all names as selected", () => {
    const state = initLegendState(["a", "b", "c"]);
    expect(state.selected).toEqual(new Set(["a", "b", "c"]));
    expect(state.activeName).toBeNull();
  });

  it("toggling a visible series hides it and clears active if it was active", () => {
    let state = initLegendState(["a", "b", "c"]);
    state = legendReducer(state, { type: "toggle", name: "a" });
    expect(state.selected).toEqual(new Set(["b", "c"]));
    expect(state.activeName).toBeNull();

    state = legendReducer(state, { type: "toggle", name: "b" });
    expect(state.selected).toEqual(new Set(["c"]));
    expect(state.activeName).toBeNull();
  });

  it("toggling a hidden series shows it and marks it as active", () => {
    let state = initLegendState(["a", "b", "c"]);
    state = legendReducer(state, { type: "toggle", name: "a" });
    state = legendReducer(state, { type: "toggle", name: "a" });
    expect(state.selected).toEqual(new Set(["a", "b", "c"]));
    expect(state.activeName).toBe("a");
  });

  it("clears active when the active series itself is hidden", () => {
    let state = initLegendState(["a", "b", "c"]);
    state = legendReducer(state, { type: "toggle", name: "a" }); // hide a (active was null)
    state = legendReducer(state, { type: "toggle", name: "a" }); // show a, active = a
    state = legendReducer(state, { type: "toggle", name: "a" }); // hide a, active cleared
    expect(state.selected).toEqual(new Set(["b", "c"]));
    expect(state.activeName).toBeNull();
  });

  it("keeps active selected when hiding another series", () => {
    let state = initLegendState(["a", "b", "c"]);
    state = legendReducer(state, { type: "toggle", name: "a" }); // hide a
    state = legendReducer(state, { type: "toggle", name: "a" }); // show a, active = a
    state = legendReducer(state, { type: "toggle", name: "b" }); // hide b, active still a
    expect(state.selected).toEqual(new Set(["a", "c"]));
    expect(state.activeName).toBe("a");
  });

  it("reset restores all names selected and clears active", () => {
    let state = initLegendState(["a", "b", "c"]);
    state = legendReducer(state, { type: "toggle", name: "a" });
    state = legendReducer(state, { type: "reset", names: ["x", "y"] });
    expect(state.selected).toEqual(new Set(["x", "y"]));
    expect(state.activeName).toBeNull();
  });

  it("set-active only keeps names that are currently selected", () => {
    let state = initLegendState(["a", "b", "c"]);
    state = legendReducer(state, { type: "set-active", name: "b" });
    expect(state.activeName).toBe("b");

    state = legendReducer(state, { type: "toggle", name: "b" }); // hide b
    expect(state.activeName).toBeNull();

    state = legendReducer(state, { type: "set-active", name: "b" }); // hidden, ignored
    expect(state.activeName).toBeNull();
  });

  it("sync-selected replaces the selected set and clears stale active", () => {
    let state = initLegendState(["a", "b", "c"]);
    state = legendReducer(state, { type: "set-active", name: "a" });
    state = legendReducer(state, { type: "sync-selected", selected: { a: false, b: true, c: true } });
    expect(state.selected).toEqual(new Set(["b", "c"]));
    expect(state.activeName).toBeNull();

    state = legendReducer(state, { type: "sync-selected", selected: { a: false, b: false, c: true } });
    expect(state.selected).toEqual(new Set(["c"]));
  });
});

describe("buildSelectedMap", () => {
  it("builds an ECharts-compatible selected map including false entries", () => {
    const selected = new Set(["a", "c"]);
    const map = buildSelectedMap(selected, ["a", "b", "c"]);
    expect(map).toEqual({ a: true, b: false, c: true });
  });

  it("returns false for names not in the selected set", () => {
    const map = buildSelectedMap(new Set(["x"]), ["x", "y", "z"]);
    expect(map).toEqual({ x: true, y: false, z: false });
  });
});
