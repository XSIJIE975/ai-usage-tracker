import { AlertCircle, CheckCircle2 } from "lucide-react";
import type { InstanceCredentialStatus, InstanceCredentials, ProviderInstance } from "../../types/ipc";

export interface ProviderSettingsProps {
  instance: ProviderInstance | null;
  saveDisabled: boolean;
  notice?: string;
  credentials: InstanceCredentials | null;
  credentialStatus: InstanceCredentialStatus | null;
  onChanged: () => Promise<void>;
  onReload: () => Promise<void>;
  onOpenGeneral: () => void;
}

export type SaveMessage = { kind: "success" | "error"; text: string } | null;

export function SaveMessageBanner({ message }: { message: SaveMessage }) {
  if (!message) return null;
  return message.kind === "success" ? (
    <p className="flex items-center gap-2 rounded-md border border-success/20 bg-success-soft px-3 py-2 text-[13px] text-success-soft-fg">
      <CheckCircle2 className="h-4 w-4 shrink-0" />
      {message.text}
    </p>
  ) : (
    <p className="flex items-start gap-2 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] leading-relaxed text-danger-soft-fg">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      {message.text}
    </p>
  );
}
