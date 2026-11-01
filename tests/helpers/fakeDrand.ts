// A stand-in for the League of Entropy drand relays (P2-10), so draws in tests never touch the network or wait for a
// real round. It stubs global fetch for drand URLs only (everything else goes to the original fetch) and makes the
// drand module's waits instant. Randomness for round R is SHA-256("fake-drand:" + R), so tests can recompute it.
import { createHash } from "node:crypto";
import { vi } from "vitest";
import { drandConfig } from "../../src/server/drand";

export const drand = {
  calls: [] as string[],
  /** rounds that fail (any relay) this many more times */
  failures: new Map<number, number>(),
  /** answer every request with this status instead (e.g. 503: drand down) */
  down: false,
  valueOf(round: number): string {
    return createHash("sha256").update(`fake-drand:${round}`).digest("hex");
  },
};

export function installFakeDrand(): void {
  drandConfig.sleep = async () => undefined;
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const m = url.match(/^https:\/\/[^/]*drand[^/]*\/([0-9a-f]{64})\/public\/(\d+)$/);
    if (!m) return real(input, init);
    drand.calls.push(url);
    const round = Number(m[2]);
    const left = drand.failures.get(round) ?? 0;
    if (drand.down || left > 0) {
      drand.failures.set(round, Math.max(0, left - 1));
      return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ round, randomness: drand.valueOf(round), signature: "00" }), { status: 200, headers: { "content-type": "application/json" } });
  });
}
