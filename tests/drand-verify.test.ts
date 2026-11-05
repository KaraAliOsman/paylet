// The drand check /verify runs in the browser, against a real quicknet beacon (fixture: round 33,566,234, the proof drop's).
import { afterEach, describe, expect, it, vi } from "vitest";
import { QUICKNET_CHAIN, checkBeacon, committedRound, fetchVerifiedBeacon, roundAt, roundTime } from "../src/shared/drand-verify";
import { commitRound, roundTime as serverRoundTime } from "../src/server/drand";

const real = {
  round: 33566234,
  randomness: "437546a7113a08f9fc305ac7d349b0dbf4f3f7dfc62ea89ea3e10a7c5463886c",
  signature: "9477f1a5470a304bb7b8c04dd3c38a649ce93d7ad25d06059888477af1269a437b3419e5858c79b53a7bb267ed37b3fd",
};

describe("drand beacon verification", () => {
  it("accepts a real League of Entropy signature", async () => {
    expect(await checkBeacon(real)).toEqual({ ok: true, signatureOk: true, randomnessOk: true });
  });
  it("rejects the same signature on another round", async () => {
    const r = await checkBeacon({ ...real, round: real.round + 1 });
    expect(r.signatureOk).toBe(false);
    expect(r.ok).toBe(false);
  });
  it("rejects randomness that isn't SHA-256(signature)", async () => {
    const r = await checkBeacon({ ...real, randomness: "0".repeat(64) });
    expect(r.signatureOk).toBe(true);
    expect(r.randomnessOk).toBe(false);
    expect(r.ok).toBe(false);
  });
  it("rejects a forged signature", async () => {
    const forged = real.signature.slice(0, -2) + (real.signature.endsWith("fd") ? "fe" : "fd");
    expect((await checkBeacon({ ...real, signature: forged })).ok).toBe(false);
  });
  it("the committed round is a public function of the freeze time, shared with the server", () => {
    for (const t of [1_793_000_000_000, 1_793_000_001_234, 1_793_000_002_999]) {
      expect(committedRound(t)).toBe(commitRound(t));
      expect(roundTime(committedRound(t))).toBeGreaterThan(t); // always published after the freeze
      expect(roundTime(roundAt(t))).toBe(serverRoundTime(roundAt(t)));
    }
  });
});

describe("fetching a beacon from independent relays", () => {
  afterEach(() => vi.unstubAllGlobals());
  const relays = ["https://one.example", "https://two.example"];

  it("moves on when a relay fails, and says which one answered", async () => {
    const f = vi.fn(async (url: string) => (url.startsWith(relays[0]) ? new Response("down", { status: 503 }) : Response.json(real)));
    vi.stubGlobal("fetch", f);
    const b = await fetchVerifiedBeacon(real.round, relays);
    expect(b).toMatchObject({ relay: relays[1], randomness: real.randomness, check: { ok: true } });
    expect(String(f.mock.calls[1][0])).toBe(`${relays[1]}/${QUICKNET_CHAIN}/public/${real.round}`);
  });
  it("treats an answer for another round or without a signature as a failure", async () => {
    vi.stubGlobal("fetch", async (url: string) => (url.startsWith(relays[0]) ? Response.json({ ...real, round: 1 }) : Response.json({ round: real.round, randomness: real.randomness })));
    await expect(fetchVerifiedBeacon(real.round, relays)).rejects.toThrow("incomplete beacon");
  });
  it("reports a bad signature instead of hiding it", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ ...real, signature: "a".repeat(96) }));
    const b = await fetchVerifiedBeacon(real.round, relays);
    expect(b.check.ok).toBe(false);
  });
  it("throws a plain error when no relay answers", async () => {
    vi.stubGlobal("fetch", async () => {
      throw "offline";
    });
    await expect(fetchVerifiedBeacon(real.round, relays)).rejects.toThrow("no drand relay answered");
  });
});
