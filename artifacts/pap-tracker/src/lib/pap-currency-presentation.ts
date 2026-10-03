// Keep PAP amounts as decimal strings. Number/parseFloat would lose precision
// for large balances and for the sub-micro-PAP conversion carry.
export function formatPapDecimal(value: string | null | undefined): string {
  if (value == null) return "—";
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return "—";
  const integer = match[2].replace(/^0+(?=\d)/, "");
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const sign = /[1-9]/.test(`${integer}${fraction}`) ? match[1] : "";
  return `${sign}${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""}`;
}

export function isPositivePapInput(
  value: string,
  maximum = 1_000_000_000n,
): boolean {
  if (
    value.length > 40 ||
    !/^\d+(?:\.\d{1,6})?$/.test(value) ||
    !/[1-9]/.test(value)
  )
    return false;
  const [whole, fraction = ""] = value.split(".");
  return (
    BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0")) <=
    maximum * 1_000_000n
  );
}

export function hasPapValue(value: string): boolean {
  return /^-?\d+(?:\.\d+)?$/.test(value) && /[1-9]/.test(value);
}

export function papEntryTypeLabel(type: string, zh: boolean): string {
  if (type === "award") return zh ? "舰队发放" : "Fleet award";
  if (type === "adjustment") return zh ? "管理员调整" : "Admin adjustment";
  if (type === "conversion")
    return zh ? "兑换为通用 PAP" : "Converted to common PAP";
  if (type === "account_merge")
    return zh ? "账号合并转入／转出" : "Account merge transfer";
  return type;
}
