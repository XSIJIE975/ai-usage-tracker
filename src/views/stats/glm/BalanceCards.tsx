import { Coins, CreditCard, Gift, Landmark, Wallet } from "lucide-react";
import { StatCard } from "../../../components/ui/stat-card";
import { useT } from "../../../i18n";
import type { GlmAccountBalance } from "../../../providers/glm-stats";

/** 金额展示：与统计页 DeepSeek 卡片同款 ¥ 前缀；明细缺失显示 — */
const fmtCNY = (value: number | null): string =>
  value == null ? "—" : `¥${value.toFixed(2)}`;

/**
 * 账户余额明细卡：当前余额 + 累计充值 + 赠送金额 + 累计消费（字段与控制台财务页一一对应）。
 * 信用余额仅在账户开通信用支付后出现（NOT_OPEN 时接口返回 null）。
 */
export function GlmBalanceCards({ balance }: { balance: GlmAccountBalance }) {
  const t = useT();
  const frozen = balance.frozenBalance ?? 0;
  const creditOpen = balance.creditBalance != null;

  return (
    <div className={`grid grid-cols-2 gap-4 ${creditOpen ? "xl:grid-cols-5" : "xl:grid-cols-4"}`}>
      <StatCard
        label={t("当前余额")}
        value={fmtCNY(balance.balance)}
        icon={<Wallet className="h-4 w-4" />}
        hint={
          frozen > 0
            ? `${t("冻结")} ${fmtCNY(frozen)}`
            : `${t("可用")} ${fmtCNY(balance.availableBalance)}`
        }
      />
      <StatCard
        label={t("累计充值")}
        value={fmtCNY(balance.rechargeAmount)}
        icon={<CreditCard className="h-4 w-4" />}
      />
      <StatCard
        label={t("赠送金额")}
        value={fmtCNY(balance.giveAmount)}
        icon={<Gift className="h-4 w-4" />}
      />
      <StatCard
        label={t("累计消费")}
        value={fmtCNY(balance.totalSpendAmount)}
        icon={<Coins className="h-4 w-4" />}
      />
      {creditOpen && (
        <StatCard
          label={t("信用余额")}
          value={fmtCNY(balance.creditBalance)}
          icon={<Landmark className="h-4 w-4" />}
          hint={t("已开通信用支付")}
        />
      )}
    </div>
  );
}
