export interface PublicDrop {
  id: string;
  slug: string;
  title: string;
  maker: string;
  blurb: string;
  art: string;
  priceCents: number;
  shipHoldCents: number;
  shipActualCents: number;
  units: number;
  closesAt: number;
  status: "open" | "drawn" | "settled";
  kind: string;
  seedHash: string;
  seed: string | null;
  frozenHash: string | null;
  waitlistSize: number;
  negativeTest?: boolean;
  stats: { requests: number; awaitingPerson: number; holds: number; duplicatesBlocked: number; merged: number; simulated: number; agents: number; captured: number; capturedSimulated?: number };
}

export interface Participant {
  entryId: string;
  publicId: string;
  source: string;
  agentLabel: string | null;
  status: string;
  holdCents: number | null;
  capturedCents: number | null;
  note: string | null;
  explanation: string | null;
  drop: { slug: string; title: string; maker: string; status: string; closesAt: number; units: number; art: string };
}

export interface EventRow {
  id: number;
  ts: number;
  kind: string;
  message: string;
  real: number;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown; sellerKey?: string }): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.json !== undefined) headers["content-type"] = "application/json";
  if (init?.sellerKey) headers["x-seller-key"] = init.sellerKey;
  const res = await fetch(path, { ...init, headers, body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const usd = (c: number | null | undefined) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);

export function timeLeft(ms: number): string {
  if (ms <= 0) return "closed";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ${Math.floor((ms % 60000) / 1000)}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}
