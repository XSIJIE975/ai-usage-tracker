import { z } from "zod";
import type { ProviderKind, ProviderSite } from "../types/ipc";
import { providerFormSpecs, type CredentialFieldSpec, type ThresholdSpec } from "./form-specs";
import type { FormErrorCode } from "./error-codes";

/** 备注长度上限：表单层此前无任何上限，Rust 侧也只 unwrap_or_default 不校验 */
export const NOTE_MAX_LENGTH = 60;

/** 站点在表单里永远是合法枚举值（下拉有默认值），必填性由 schema 兜住而不靠 UI 保证 */
const SITE_VALUES: ProviderSite[] = ["china", "international"];

export interface InstanceFormValues {
  note: string;
  site: ProviderSite;
  autoRefresh: boolean;
  /** 阈值以字符串进表单：number input 的空值与 0 无法区分，留空 = 不告警 */
  threshold: string;
  balanceThreshold: string;
  credentials: Record<string, string>;
}

/**
 * 表单值就是事实源：编辑态打开时凭据框已回填库里的值，所以格子空了就是用户主动清空，
 * 必填格要按缺失拦下来（清空一项必填凭据走旁边的「清除」按钮，它是显式的即时动作）。
 *
 * credentialsLoaded 是唯一的例外：凭据还没从库里读出来（未解锁、读取失败或尚未返回）时，
 * 空格子反映的是「没读到」而不是「用户清空」，此时既不能按必填拦（否则锁库时连备注都改不了），
 * 保存路径也必须跳过凭据写入（否则会把没加载到的格子写成 null，等于把凭据删了）。
 */
function credentialFieldSpec(rule: CredentialFieldSpec, credentialsLoaded: boolean) {
  return z.string().superRefine((raw, issue) => {
    const value = raw.trim();
    if (!value) {
      if (!rule.required || !credentialsLoaded) return;
      issue.addIssue({ code: "custom", message: "required" satisfies FormErrorCode });
      return;
    }
    // 归一化后再校验：与保存路径同口径（存的就是归一化后的值）
    const normalized = rule.normalize ? rule.normalize(value) : value;
    const code = rule.validate?.(normalized);
    if (code) issue.addIssue({ code: "custom", message: code });
  });
}

/**
 * 阈值：留空不告警；填了就必须是范围内的整数。
 * 取代原先的静默 clamp（Math.min/Math.max 把用户输入悄悄改掉）——超范围是用户的输入
 * 错误，该报错让他看见，而不是存进去一个他没写过的数。
 */
function thresholdFieldSpec(spec: ThresholdSpec) {
  return z.string().superRefine((raw, issue) => {
    const value = raw.trim();
    if (!value) return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      issue.addIssue({ code: "custom", message: "threshold_not_number" satisfies FormErrorCode });
      return;
    }
    if (!Number.isInteger(parsed)) {
      issue.addIssue({ code: "custom", message: "threshold_not_integer" satisfies FormErrorCode });
      return;
    }
    if (parsed < spec.min || parsed > spec.max) {
      issue.addIssue({ code: "custom", message: "threshold_out_of_range" satisfies FormErrorCode });
    }
  });
}

export function buildInstanceSchema(kind: ProviderKind, credentialsLoaded: boolean) {
  const spec = providerFormSpecs[kind];
  return z.object({
    note: z.string().trim().max(NOTE_MAX_LENGTH, "note_too_long" satisfies FormErrorCode),
    site: z.enum(SITE_VALUES as [ProviderSite, ...ProviderSite[]]),
    autoRefresh: z.boolean(),
    threshold: thresholdFieldSpec(spec.threshold),
    balanceThreshold: thresholdFieldSpec(spec.balanceThreshold ?? spec.threshold),
    credentials: z.object(
      Object.fromEntries(
        spec.fields.map((field) => [field.slot, credentialFieldSpec(field, credentialsLoaded)]),
      ),
    ),
  });
}
