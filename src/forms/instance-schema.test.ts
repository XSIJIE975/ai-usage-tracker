import { describe, expect, it } from "vitest";
import type { ProviderKind } from "../types/ipc";
import { providerFormSpecs } from "./form-specs";
import { FORM_ERROR_TEXT } from "./error-codes";
import { buildInstanceSchema, NOTE_MAX_LENGTH, type InstanceFormValues } from "./instance-schema";

const KINDS = Object.keys(providerFormSpecs) as ProviderKind[];

/**
 * 必填矩阵的事实源：各 provider fetch 里那句 needs_config 判据。
 * 与 form-specs 的 required 标记分开放，是为了让「表单说要必填」和「取数真需要必填」
 * 两处不一致时这条用例变红——同处声明的话就只是自己跟自己比。
 */
const REQUIRED_SLOTS: Record<ProviderKind, string[]> = {
  deepseek: ["apiKey"], // deepseek.ts:33
  "opencode-go": ["workspaceId", "cookie"], // opencode-go.ts:123
  glm: ["planKey"], // glm.ts:387
  workbuddy: ["session", "session2", "userAgent"], // workbuddy.ts:593
  qoder: ["cookie"], // qoder.ts:283
};

/** 各槽位一个能通过格式校验的合法值 */
const VALID: Record<string, string> = {
  apiKey: "sk-abcdef123456",
  userToken: "eyJ0b2tlbiI6Im9rIn0",
  workspaceId: "wrk_123456",
  cookie: "abcdefghij",
  planKey: "c9f2a1b3d4e5f60718293a4b",
  session: "sessionvalue1",
  session2: "sessionvalue2",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
};

function valuesFor(
  kind: ProviderKind,
  credentials: Record<string, string>,
  rest: Partial<InstanceFormValues> = {},
): InstanceFormValues {
  return {
    note: "",
    site: "china",
    autoRefresh: true,
    threshold: "",
    balanceThreshold: "",
    credentials: Object.fromEntries(
      providerFormSpecs[kind].fields.map((field) => [field.slot, credentials[field.slot] ?? ""]),
    ),
    ...rest,
  };
}

/** 槽位 → 错误码；缺省空对象表示该槽没有错误。credentialsLoaded 默认 true（新建即视为已就绪） */
function credentialErrors(
  kind: ProviderKind,
  credentials: Record<string, string>,
  credentialsLoaded = true,
) {
  const schema = buildInstanceSchema(kind, credentialsLoaded);
  const result = schema.safeParse(valuesFor(kind, credentials));
  if (result.success) return {};
  const bySlot: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const slot = issue.path[issue.path.length - 1];
    if (issue.path[0] !== "credentials") continue;
    bySlot[String(slot)] = [...(bySlot[String(slot)] ?? []), issue.message];
  }
  return bySlot;
}

function fieldErrors(kind: ProviderKind, rest: Partial<InstanceFormValues>) {
  const schema = buildInstanceSchema(kind, true);
  const result = schema.safeParse(valuesFor(kind, {}, rest));
  if (result.success) return {};
  const out: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    if (issue.path[0] === "credentials") continue;
    out[String(issue.path[0])] = [...(out[String(issue.path[0])] ?? []), issue.message];
  }
  return out;
}

describe("必填矩阵", () => {
  it("form-specs 的 required 标记与 needs_config 判据一致", () => {
    for (const kind of KINDS) {
      const required = providerFormSpecs[kind].fields
        .filter((field) => field.required)
        .map((field) => field.slot);
      expect(required, kind).toEqual(REQUIRED_SLOTS[kind]);
    }
  });

  it("必填槽留空报「该项为必填」，选填槽不报", () => {
    for (const kind of KINDS) {
      const errors = credentialErrors(kind, {});
      for (const field of providerFormSpecs[kind].fields) {
        const codes = errors[field.slot] ?? [];
        if (field.required) expect(codes, `${kind}/${field.slot}`).toContain("required");
        else expect(codes, `${kind}/${field.slot}`).toEqual([]);
      }
    }
  });

  it("必填槽都填上合法值即通过", () => {
    for (const kind of KINDS) {
      const filled = Object.fromEntries(
        providerFormSpecs[kind].fields.map((field) => [field.slot, VALID[field.slot] ?? "value"]),
      );
      expect(credentialErrors(kind, filled), kind).toEqual({});
    }
  });
});

describe("空值语义：表单值就是事实源", () => {
  // 编辑态会把库里的凭据明文回填进格子，所以「格子空了」是一次主动删除，
  // 不是「没填」。此前按 configured 放宽，导致删干净点保存既不报错也不写库，
  // 旧值原封不动回来——用户看到的是自己的操作被吞掉。
  it("必填槽清空即缺失，不再因为「库里本来有值」而放行", () => {
    const errors = credentialErrors("workbuddy", { session: "s1value" });
    expect(errors.session).toBeUndefined();
    expect(errors.session2).toContain("required");
    expect(errors.userAgent).toContain("required");
  });

  it("选填槽清空合法（保存时按 null 写回，即真的删掉）", () => {
    expect(credentialErrors("deepseek", { apiKey: VALID.apiKey })).toEqual({});
    expect(credentialErrors("opencode-go", { workspaceId: "wrk_1", cookie: "abcdefgh" })).toEqual({});
  });

  it("凭据还没从库里读出来时不按必填拦：那时空格子代表「没读到」，不是用户清空", () => {
    expect(credentialErrors("workbuddy", {}, false)).toEqual({});
    // 但读到了值就照常校验格式
    expect(credentialErrors("qoder", { cookie: "Cookie: abc" }, false).cookie).toContain(
      "qoder_cookie_value",
    );
  });
});

describe("格式校验：复用供应商模块的同口径谓词", () => {
  it("qoder 拒「Cookie:」前缀与带空格/分号的整段 Cookie", () => {
    for (const bad of ["Cookie: abc", "qoder_session_cookie=abc", "abc def", "a;b"]) {
      expect(credentialErrors("qoder", { cookie: bad }).cookie, bad).toContain("qoder_cookie_value");
    }
  });

  it("workbuddy 两个 Cookie 格拒分号与空格，UA 格拒换行", () => {
    const errors = credentialErrors("workbuddy", { session: "a b", userAgent: "a\nb" });
    expect(errors.session).toContain("workbuddy_cookie_value");
    expect(errors.userAgent).toContain("workbuddy_ua_value");
  });
});

describe("阈值：报错取代静默 clamp", () => {
  it("留空即不告警", () => {
    expect(fieldErrors("deepseek", { threshold: "" })).not.toHaveProperty("threshold");
  });

  it("超出范围报范围错误，而不是被改写", () => {
    // opencode 的下限是 1：0 原先会被 Math.max 悄悄改成 1
    expect(fieldErrors("opencode-go", { threshold: "0" }).threshold).toContain("threshold_out_of_range");
    expect(fieldErrors("opencode-go", { threshold: "101" }).threshold).toContain("threshold_out_of_range");
    expect(fieldErrors("deepseek", { threshold: "1000001" }).threshold).toContain("threshold_out_of_range");
    expect(fieldErrors("glm", { balanceThreshold: "2000000" }).balanceThreshold).toContain(
      "threshold_out_of_range",
    );
  });

  it("范围内合法值通过；边界值含端点", () => {
    expect(fieldErrors("opencode-go", { threshold: "1" })).not.toHaveProperty("threshold");
    expect(fieldErrors("opencode-go", { threshold: "100" })).not.toHaveProperty("threshold");
    expect(fieldErrors("deepseek", { threshold: "0" })).not.toHaveProperty("threshold");
  });

  it("非整数与非数字分别报错", () => {
    expect(fieldErrors("glm", { threshold: "50.5" }).threshold).toContain("threshold_not_integer");
    expect(fieldErrors("glm", { threshold: "abc" }).threshold).toContain("threshold_not_number");
  });
});

describe("备注", () => {
  it("超过上限报错，未超过通过", () => {
    expect(fieldErrors("glm", { note: "x".repeat(NOTE_MAX_LENGTH + 1) }).note).toContain("note_too_long");
    expect(fieldErrors("glm", { note: "x".repeat(NOTE_MAX_LENGTH) })).not.toHaveProperty("note");
    expect(fieldErrors("glm", { note: "" })).not.toHaveProperty("note");
  });
});

describe("错误码封闭性", () => {
  it("schema 只会产出字典里登记过的码", () => {
    const known = new Set<string>(Object.keys(FORM_ERROR_TEXT));
    for (const kind of KINDS) {
      const schema = buildInstanceSchema(kind, true);
      const result = schema.safeParse(
        valuesFor(
          kind,
          Object.fromEntries(providerFormSpecs[kind].fields.map((field) => [field.slot, "!!; bad"])),
          { note: "x".repeat(200), threshold: "999999999", balanceThreshold: "1.5" },
        ),
      );
      expect(result.success).toBe(false);
      if (result.success) continue;
      for (const issue of result.error.issues) {
        expect(known.has(issue.message), `${kind} 产出了未登记的码：${issue.message}`).toBe(true);
      }
    }
  });
});
