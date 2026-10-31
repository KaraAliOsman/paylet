// Deterministic, verifiable allocation draw (commit-reveal).
// The same code runs on the server (to settle) and in the browser (/verify).
//
// 1. When a drop is created the server picks a random 32-byte seed and publishes SHA-256(seed).
// 2. When entries close, the eligible entry list is frozen and SHA-256(list) is published.
// 3. At draw time the seed is revealed. Each entry's rank key is SHA-256(seed + ":" + publicId).
//    Entries are sorted by that key; the first `units` win, the next ones form the waitlist.

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Canonical serialisation of the frozen eligible list (sorted public ids, newline separated). */
export function canonicalList(publicIds: string[]): string {
  return [...publicIds].sort().join("\n");
}

export interface DrawResult {
  ranking: { publicId: string; key: string }[];
  winners: string[];
  waitlist: string[];
}

export async function computeDraw(seed: string, publicIds: string[], units: number, waitlistSize = 3): Promise<DrawResult> {
  const ranking = await Promise.all(
    [...new Set(publicIds)].map(async (publicId) => ({ publicId, key: await sha256Hex(`${seed}:${publicId}`) })),
  );
  ranking.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const winners = ranking.slice(0, units).map((r) => r.publicId);
  const waitlist = ranking.slice(units, units + waitlistSize).map((r) => r.publicId);
  return { ranking, winners, waitlist };
}
