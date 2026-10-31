// All amounts are integer cents internally; PayPal wants decimal strings.

export function toPayPal(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`invalid cents: ${cents}`);
  return (cents / 100).toFixed(2);
}

export function fromPayPal(value: string | undefined | null): number {
  if (!value) return 0;
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
