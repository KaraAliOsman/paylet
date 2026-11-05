// Verifies a drand quicknet beacon with no trust in Paylet or in the relay that served it. Used by /verify in the browser
// and by scripts/verify-drop.ts. quicknet ("bls-unchained-g1-rfc9380"): the League of Entropy's threshold group signs
// SHA-256(round as 8 big-endian bytes) with BLS12-381, signature on G1, public key on G2; randomness = SHA-256(signature).
import { bls12_381 } from "@noble/curves/bls12-381.js";
import { sha256Hex } from "./draw";

export const QUICKNET_CHAIN = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
export const QUICKNET_PUBLIC_KEY =
  "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
export const QUICKNET_GENESIS_S = 1692803367;
export const QUICKNET_PERIOD_S = 3;
export const FREEZE_LEAD_MS = 6_000;
/** Independent relays of the same chain. Picked here, never taken from the server being checked. */
export const QUICKNET_RELAYS = ["https://api.drand.sh", "https://api2.drand.sh", "https://drand.cloudflare.com"];

const DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

export const roundAt = (ms: number) => Math.floor((ms / 1000 - QUICKNET_GENESIS_S) / QUICKNET_PERIOD_S) + 1;
export const roundTime = (round: number) => (QUICKNET_GENESIS_S + (round - 1) * QUICKNET_PERIOD_S) * 1000;
/** The only round a freeze at `frozenAt` may use: the rule is public, so the operator can't pick another one. */
export const committedRound = (frozenAt: number) => roundAt(frozenAt + FREEZE_LEAD_MS);

const hexToBytes = (h: string) => Uint8Array.from(h.match(/.{2}/g) ?? [], (b) => parseInt(b, 16));

export interface BeaconCheck {
  ok: boolean;
  /** the signature really is the League of Entropy's, for this round */
  signatureOk: boolean;
  /** randomness = SHA-256(signature) */
  randomnessOk: boolean;
}

export async function checkBeacon(b: { round: number; randomness: string; signature: string }): Promise<BeaconCheck> {
  const roundBytes = new Uint8Array(8);
  new DataView(roundBytes.buffer).setBigUint64(0, BigInt(b.round));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", roundBytes));
  let signatureOk = false;
  try {
    const short = bls12_381.shortSignatures;
    signatureOk = short.verify(short.Signature.fromHex(b.signature), short.hash(digest, DST), hexToBytes(QUICKNET_PUBLIC_KEY));
  } catch {
    signatureOk = false;
  }
  const sigBytes = hexToBytes(b.signature);
  const randomnessOk = (await sha256Bytes(sigBytes)) === b.randomness;
  return { ok: signatureOk && randomnessOk, signatureOk, randomnessOk };
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Fetches a round from the relays in order and verifies it. Throws when no relay answers. */
export async function fetchVerifiedBeacon(round: number, relays = QUICKNET_RELAYS): Promise<{ round: number; randomness: string; relay: string; check: BeaconCheck }> {
  let last: unknown;
  for (const relay of relays) {
    try {
      const res = await fetch(`${relay}/${QUICKNET_CHAIN}/public/${round}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { round?: number; randomness?: string; signature?: string };
      if (j.round !== round || !j.randomness || !j.signature) throw new Error("incomplete beacon");
      return { round, randomness: j.randomness, relay, check: await checkBeacon({ round, randomness: j.randomness, signature: j.signature }) };
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("no drand relay answered");
}

export { sha256Hex };
