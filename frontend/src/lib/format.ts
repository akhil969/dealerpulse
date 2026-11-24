/** Indian-style currency: ₹1.2 Cr, ₹45.0 L, ₹8,500. */
export function inr(value: number, digits = 1): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(digits)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(digits)} L`;
  return `${sign}₹${Math.round(abs).toLocaleString("en-IN")}`;
}

export function pct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function num(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2025-06" -> "Jun 2025" (or "Jun" when short). */
export function monthLabel(month: string, short = false): string {
  const [y, m] = month.split("-");
  const name = MONTHS[Number(m) - 1] ?? m;
  return short ? name : `${name} ${y}`;
}

export function dateLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function titleCase(s: string): string {
  return s
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export const STATUS_LABEL: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  test_drive: "Test drive",
  negotiation: "Negotiation",
  order_placed: "Order placed",
  delivered: "Delivered",
  lost: "Lost",
};
