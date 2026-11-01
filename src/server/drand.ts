// Public randomness for the draw (P2-10): League of Entropy drand, "quicknet" chain (a new round every 3 s).
// At the freeze Paylet commits to a round that does not exist yet (≈ 3-6 s in the future). Once it is published the
// final draw seed is SHA-256(seed + ":" + randomness), so not even Paylet knew the winners before the list was frozen.
// Anyone can fetch the same round in a browser (the relays send Access-Control-Allow-Origin: *) and recompute.
import { createHash } from "node:crypto";

export const DRAND_CHAIN_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
export const DRAND_GENESIS_S = 1692803367;
export const DRAND_PERIOD_S = 3;
/** The relay recorded in the public `randomness.url` (the one /verify fetches). */
export const DRAND_PRIMARY = "https://api.drand.sh";
/** Same chain, same values: used only for retries. All of them are allowed by the CSP connect-src. */
export const DRAND_RELAYS = [DRAND_PRIMARY, "https://api2.drand.sh", "https://drand.cloudflare.com"];
/** The committed round is the one current this long after the freeze (so it is always published after it). */
export const FREEZE_LEAD_MS = 6_000;

/** Test hooks: tests stub `fetch` for the drand URLs and make waiting instant. */
export const drandConfig = {
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms))),
  /** backoff between the 3 tries of one round */
  retryDelaysMs: [1_000, 2_000, 4_000],
  timeoutMs: 8_000,
};

/** drand round current at `ms` (round 1 was published at genesis). */
export function roundAt(ms: number): number {
  return Math.floor((ms / 1000 - DRAND_GENESIS_S) / DRAND_PERIOD_S) + 1;
}

/** When `round` is published (ms). */
export function roundTime(round: number): number {
  return (DRAND_GENESIS_S + (round - 1) * DRAND_PERIOD_S) * 1000;
}

/** The round committed to by a freeze at `nowMs`: R = floor((now + 6 s − genesis) / 3) + 1. */
export function commitRound(nowMs: number): number {
  return roundAt(nowMs + FREEZE_LEAD_MS);
}

export function roundUrl(round: number, relay = DRAND_PRIMARY): string {
  return `${relay}/${DRAND_CHAIN_HASH}/public/${round}`;
}

/** Final draw seed after the reveal: SHA-256(seed + ":" + randomness), hex. Same as sha256Hex(`${seed}:${value}`). */
export function finalSeedOf(seed: string, randomness: string): string {
  return createHash("sha256").update(`${seed}:${randomness}`).digest("hex");
}

export interface Beacon {
  round: number;
  randomness: string;
}

/** GET one round from one relay. Throws unless the relay answers that exact round with 32 bytes of hex randomness. */
export async function fetchRound(round: number, relay = DRAND_PRIMARY): Promise<Beacon> {
  const res = await fetch(roundUrl(round, relay), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(drandConfig.timeoutMs) });
  if (!res.ok) throw new Error(`drand HTTP ${res.status}`);
  const j = (await res.json()) as { round?: unknown; randomness?: unknown };
  if (j.round !== round) throw new Error(`drand answered round ${String(j.round)} instead of ${round}`);
  if (typeof j.randomness !== "string" || !/^[0-9a-f]{64}$/.test(j.randomness)) throw new Error("drand answered without valid randomness");
  return { round, randomness: j.randomness };
}

/** Waits until `round` is published, then tries it 3 times (rotating relays, 1/2/4 s apart). Null if every try failed. */
export async function fetchRoundWithRetries(round: number, onError?: (e: unknown, attempt: number) => void): Promise<Beacon | null> {
  const wait = roundTime(round) + 250 - Date.now();
  if (wait > 0) await drandConfig.sleep(wait);
  const tries = drandConfig.retryDelaysMs.length;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fetchRound(round, DRAND_RELAYS[attempt % DRAND_RELAYS.length]);
    } catch (e) {
      onError?.(e, attempt);
      await drandConfig.sleep(drandConfig.retryDelaysMs[attempt]);
    }
  }
  return null;
}
