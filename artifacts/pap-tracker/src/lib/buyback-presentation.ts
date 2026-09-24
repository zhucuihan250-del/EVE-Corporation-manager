// ISK values remain decimal strings throughout the UI: never round a contract
// total through JavaScript's floating-point number conversion.
export function formatBuybackIsk(value: string | null | undefined): string {
  if (value == null) return "—";
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return value;
  return `${match[1].replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${match[2] ? `.${match[2]}` : ""} ISK`;
}

export function canCopyBuybackQuote(
  quote: { complete: boolean; totalIsk: string; expiresAt: string },
  now: number,
): boolean {
  const expiresAt = Date.parse(quote.expiresAt);
  return (
    quote.complete &&
    Number.isFinite(now) &&
    Number.isFinite(expiresAt) &&
    now < expiresAt &&
    /^\d+(?:\.\d{1,2})?$/.test(quote.totalIsk) &&
    /[1-9]/.test(quote.totalIsk)
  );
}
