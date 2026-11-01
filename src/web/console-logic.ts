// Pure helpers for the seller console (no React, so e2e/ui-logic.spec.ts can test them directly).
import type { Address, Cluster, SellerEntry } from "./api";

/** "primalabs-ai/MiMo-V2.6-Pro" → "MiMo V2.6 Pro" */
export function prettyModel(model: string | null | undefined): string {
  if (!model) return "AI";
  const last = model.split("/").pop() ?? model;
  return last.replace(/[-_]+/g, " ").trim();
}

const normToken = (t: string) => t.toUpperCase().replace(/^[^A-Z0-9#]+|[^A-Z0-9]+$/g, "");

export interface DiffToken {
  text: string;
  differs: boolean;
}

/**
 * Splits one address variant into tokens and marks the ones that are not in the normalized key, e.g. against
 * "1200 HARBOR BLVD STE 4B 43215": "1200 Harbour Boulevard #4B" → Harbour, Boulevard and #4B differ.
 * Case and trailing punctuation don't count as a difference ("Blvd." = "BLVD").
 */
export function addressDiff(variant: string, normalizedKey: string): DiffToken[] {
  const key = new Set(normalizedKey.split(/\s+/).map(normToken).filter(Boolean));
  return variant
    .split(/(\s+)/)
    .filter((t) => t.length > 0)
    .map((t) => {
      if (/^\s+$/.test(t)) return { text: t, differs: false };
      const n = normToken(t);
      return { text: t, differs: n.length > 0 && !key.has(n) };
    });
}

/** The part of an address the normalized key covers (street, unit, ZIP). */
export const addressLine = (a: Address | null | undefined) => (a ? [a.line1, a.line2, a.zip].filter(Boolean).join(" ") : "");

const HOLD_EXISTED = new Set(["held", "won", "waitlist", "lost", "captured", "voided", "capture_failed", "refunded"]);

/** Scalper swarm result for step 1: "12 PayPal links · 0 holds". */
export function swarmResult(entries: SellerEntry[]): { links: number; holds: number } {
  const bots = entries.filter((e) => e.source === "agent" && /^scalper/i.test(e.agentLabel ?? ""));
  return { links: bots.length, holds: bots.filter((e) => HOLD_EXISTED.has(e.status)).length };
}

/** Clusters for review: reseller networks first, then AI-adjudicated, then the most confident. */
export function sortClusters(clusters: Cluster[]): Cluster[] {
  return clusters
    .slice()
    .sort(
      (a, b) =>
        (a.kind === "operator" ? 0 : 1) - (b.kind === "operator" ? 0 : 1) ||
        (a.method === "ai" ? 0 : 1) - (b.method === "ai" ? 0 : 1) ||
        b.confidence - a.confidence,
    );
}

/** "2 AI suggestions are still pending: 6 accounts would each keep a ticket. Review them first." */
export function pendingCopy(clusters: Cluster[]): string {
  const pending = clusters.filter((c) => c.status === "suggested");
  const n = pending.length;
  const accounts = new Set(pending.flatMap((c) => c.memberIds)).size;
  if (n === 0) return "Some AI suggestions are still pending. Review them first.";
  return `${n} AI suggestion${n === 1 ? " is" : "s are"} still pending: ${accounts} accounts would each keep a ticket. Review them first.`;
}

/** What "Close & draw" will do: winners = min(units, eligible holds), ≈ amount at price + actual shipping. */
export function drawPreview(entries: SellerEntry[], units: number, captureCents: number): { eligible: number; winners: number; cents: number } {
  const eligible = entries.filter((e) => e.status === "held").length;
  const winners = Math.min(units, eligible);
  return { eligible, winners, cents: winners * captureCents };
}

/** Masked PayPal authorization for display ("…7K2Q"), whatever the server sent. */
export function maskedAuth(e: Pick<SellerEntry, "authorization" | "authorizationId">): string | null {
  if (e.authorization) return e.authorization;
  if (e.authorizationId) return `…${e.authorizationId.slice(-4)}`;
  return null;
}

/** A demo USPS tracking number (22 digits, 9400 1…), so "Mark shipped" is one click. */
export function demoTracking(seed = Date.now()): string {
  let s = "94001";
  let x = seed % 2147483647 || 1;
  while (s.length < 22) {
    x = (x * 48271) % 2147483647;
    s += String(x % 10);
  }
  return s;
}
