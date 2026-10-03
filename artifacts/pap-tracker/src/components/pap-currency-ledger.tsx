import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { PapCurrency, PapCurrencyEntry } from "@/lib/pap-currency-api";
import {
  formatPapDecimal,
  hasPapValue,
  papEntryTypeLabel,
} from "@/lib/pap-currency-presentation";

export function PapCurrencyStatus({ currency }: { currency: PapCurrency }) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant={currency.issuanceEnabled ? "outline" : "secondary"}>
        {currency.issuanceEnabled
          ? zh
            ? "可发放"
            : "Issuance enabled"
          : zh
            ? "暂停发放"
            : "Issuance paused"}
      </Badge>
      <Badge variant={currency.conversionEnabled ? "outline" : "secondary"}>
        {currency.conversionEnabled
          ? zh
            ? "可兑换"
            : "Conversion enabled"
          : zh
            ? "暂停兑换"
            : "Conversion paused"}
      </Badge>
    </div>
  );
}

export function PapCurrencyLedger({
  entries,
  showMember = false,
}: {
  entries: PapCurrencyEntry[];
  showMember?: boolean;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => (zh ? cn : en);
  if (!entries.length)
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {tr("暂无自定义 PAP 流水。", "No custom PAP transactions yet.")}
      </p>
    );
  return (
    <div className="overflow-x-auto rounded-md border border-border/60">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="border-b border-border/60 bg-muted/20 text-xs text-muted-foreground">
          <tr>
            {[
              tr("时间／记录", "Time / record"),
              ...(showMember ? [tr("成员", "Member")] : []),
              tr("种类／操作", "Currency / action"),
              tr("数量变动／余额", "Change / balance"),
              tr("兑换记录", "Conversion"),
              tr("说明", "Reason"),
            ].map((label) => (
              <th key={label} className="p-3 font-medium">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={entry.id}
              className="border-b border-border/40 align-top last:border-0"
            >
              <td className="p-3 text-xs text-muted-foreground">
                <div>{new Date(entry.createdAt).toLocaleString()}</div>
                <div className="mt-1">#{entry.id}</div>
              </td>
              {showMember && (
                <td className="max-w-[180px] break-words p-3">
                  {entry.userName}
                </td>
              )}
              <td className="max-w-[180px] break-words p-3">
                <div className="font-medium">{entry.currencyName}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {papEntryTypeLabel(entry.type, zh)}
                </div>
              </td>
              <td className="p-3 tabular-nums">
                <div
                  className={
                    entry.amount.startsWith("-")
                      ? "text-amber-300"
                      : "text-emerald-400"
                  }
                >
                  {entry.amount.startsWith("-") ? "" : "+"}
                  {formatPapDecimal(entry.amount)}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatPapDecimal(entry.balanceBefore)} →{" "}
                  {formatPapDecimal(entry.balanceAfter)}
                </div>
              </td>
              <td className="p-3 tabular-nums">
                {entry.type === "conversion" ? (
                  <>
                    <div>
                      +{formatPapDecimal(entry.commonAmount)}{" "}
                      {tr("通用 PAP", "common PAP")}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {tr("当时比例", "Historical rate")} 1 :{" "}
                      {formatPapDecimal(entry.rate)}
                    </div>
                    {(hasPapValue(entry.carryBefore) ||
                      hasPapValue(entry.carryAfter)) && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {tr("保留尾数", "Carry")}:{" "}
                        {formatPapDecimal(entry.carryBefore)} →{" "}
                        {formatPapDecimal(entry.carryAfter)}
                      </div>
                    )}
                  </>
                ) : entry.type === "account_merge" &&
                  hasPapValue(entry.commonAmount) ? (
                  <div>
                    +{formatPapDecimal(entry.commonAmount)}{" "}
                    {tr(
                      "通用 PAP（合并尾数入账）",
                      "common PAP (merged carry credit)",
                    )}
                  </div>
                ) : (
                  "—"
                )}
              </td>
              <td className="max-w-[260px] whitespace-pre-wrap break-words p-3 text-xs text-muted-foreground">
                {entry.reason || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
