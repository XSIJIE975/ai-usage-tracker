import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRpcResponse } from "./opencode-rpc-parser";

const readFixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

type UnknownRecord = Record<string, unknown>;

const parseAsRecord = (bodyText: string): UnknownRecord =>
  parseRpcResponse(bodyText) as UnknownRecord;

describe("parseRpcResponse", () => {
  it("parses the monthly aggregation fixture into the raw usage/keys object", () => {
    const payload = parseAsRecord(readFixture("opencode-rpc-monthly.txt"));
    const usage = payload.usage as Array<UnknownRecord>;
    const keys = payload.keys as Array<UnknownRecord>;

    expect(usage).toHaveLength(6);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual({
      id: "key_TESTKEYAAAAAAAAAAAAAAAAA",
      displayName: "user@example.com - Default API Key",
      deleted: false,
    });
    expect(keys[1]?.displayName).toBe("user@example.com - workbuddy");
    expect(keys[1]?.deleted).toBe(false);
  });

  it("keeps !0 as true and inline $R assignments transparent in the monthly fixture", () => {
    const payload = parseAsRecord(readFixture("opencode-rpc-monthly.txt"));
    const usage = payload.usage as Array<UnknownRecord>;

    const aug14 = usage.find((row) => row.date === "2026-08-14" && row.model === "deepseek-v4-flash");
    expect(aug14?.totalCost).toBe(300000000);
    expect(aug14?.plan).toBe("lite");
  });

  it("parses the history fixture array with new Date(...) restored to ISO strings", () => {
    const records = parseRpcResponse(readFixture("opencode-rpc-history.txt")) as Array<UnknownRecord>;

    expect(records).toHaveLength(5);
    expect(records[0]?.id).toBe("usg_01TEST0000000000000000000A1");
    expect(records[0]?.timeCreated).toBe("2026-08-24T01:49:24.000Z");
    expect(records[0]?.timeDeleted).toBeNull();
    expect(records[3]?.cost).toBe(21000);
    expect(records[4]?.sessionID).toBe("ses_TESTSESSION00000000002");
  });

  it("does not mangle !0, braces or $R markers appearing inside strings", () => {
    const body =
      '($R => $R[0] = { note: "has !0 and { and $R[3] = inside", ok: !0 })($R["server-fn:0"]))';
    const payload = parseAsRecord(body);

    expect(payload.note).toBe("has !0 and { and $R[3] = inside");
    expect(payload.ok).toBe(true);
  });

  it("supports scientific notation numbers", () => {
    const payload = parseAsRecord('$R[0] = { tiny: 1.5e-7, big: 2E+3 }');

    expect(payload.tiny).toBe(1.5e-7);
    expect(payload.big).toBe(2000);
  });

  it("tolerates trailing whitespace after the root value", () => {
    const value = parseRpcResponse('$R[0] = [1, 2]   \n\t ') as number[];

    expect(value).toEqual([1, 2]);
  });

  it("parses null values and negative fractional numbers", () => {
    const payload = parseAsRecord('$R[0] = { gone: null, delta: -42.5 }');

    expect(payload.gone).toBeNull();
    expect(payload.delta).toBe(-42.5);
  });

  it("throws with position info on truncated input", () => {
    expect(() => parseRpcResponse('$R[0] = { date: "2026-08-14"')).toThrow(/位置 \d+/);
    expect(() => parseRpcResponse('$R[0] = [1, 2')).toThrow(/位置 \d+/);
  });

  it("throws when the $R[0] target marker is missing", () => {
    expect(() => parseRpcResponse("<html>gateway error</html>")).toThrow(/\$R\[0\]/);
  });

  it("throws on unterminated strings", () => {
    expect(() => parseRpcResponse('$R[0] = { note: "never closed' )).toThrow(/字符串未闭合/);
  });
});
