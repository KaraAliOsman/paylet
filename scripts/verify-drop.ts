// Check a Paylet draw from your own machine, trusting neither Paylet's page nor the relay that served the randomness.
//
//   pnpm verify:drop https://paylet.onrender.com/d/ember-glaze-mug-2710
//
// What it does: downloads the drop's published data once, then recomputes everything itself. The drand chain key, the
// relays and the round rule live in this file's imports, not in anything the server sends. Exit code 0 = every check passed.
import { canonicalList, computeDraw, sha256Hex } from "../src/shared/draw";
import { QUICKNET_RELAYS, committedRound, fetchVerifiedBeacon } from "../src/shared/drand-verify";
import { reconcile } from "../src/web/verify-logic";

interface VerifyData {
  title: string;
  status: string;
  units: number;
  waitlistSize: number;
  frozenAt?: number | null;
  negativeTest?: boolean;
  seedHash: string;
  seed: string | null;
  frozenHash: string | null;
  frozenList: string[] | null;
  randomness?: { round: number; value: string | null } | null;
  finalSeed?: string | null;
  outcome: { publicId: string; status: string; simulated?: boolean }[];
}

const arg = process.argv[2];
if (!arg) {
  console.error("usage: pnpm verify:drop <drop url, e.g. https://paylet.onrender.com/d/ember-glaze-mug-2710>");
  process.exit(2);
}
const url = new URL(arg);
const slug = url.pathname.split("/").filter(Boolean).pop()!;
const res = await fetch(`${url.origin}/api/drops/${slug}/verify`);
if (!res.ok) throw new Error(`${url.origin} answered ${res.status} for ${slug}`);
const d = (await res.json()) as VerifyData;

let failed = 0;
const check = (ok: boolean, text: string) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${text}`);
  if (!ok) failed++;
};

console.log(`\n${d.title} (${slug}): ${d.status}, ${d.units} unit(s)\n`);
if (!d.seed || !d.frozenList) {
  console.log("Not drawn yet: nothing to verify.");
  process.exit(0);
}

check((await sha256Hex(d.seed)) === d.seedHash, "the revealed seed matches the commitment published when the drop opened");
check((await sha256Hex(canonicalList(d.frozenList))) === d.frozenHash, `the ${d.frozenList.length} frozen entries match the hash published before the reveal`);

const r = d.randomness;
let drawSeed = d.seed;
if (d.frozenList.length && !r?.value) check(false, "this draw used public randomness");
if (r?.value) {
  if (d.frozenAt) check(committedRound(d.frozenAt) === r.round, `round ${r.round} is the only one the public rule allows for this freeze time`);
  else console.log(" skip  the server gave no freeze time");
  const b = await fetchVerifiedBeacon(r.round, QUICKNET_RELAYS);
  check(b.check.ok, `round ${r.round} from ${new URL(b.relay).hostname} carries a valid League of Entropy BLS signature`);
  check(b.randomness === r.value, "that randomness is the one Paylet used");
  drawSeed = await sha256Hex(`${d.seed}:${b.randomness}`);
  check(drawSeed === d.finalSeed, "SHA-256(seed:randomness) gives the published final seed");
}

const draw = await computeDraw(drawSeed, d.frozenList, d.units, d.waitlistSize);
const rec = reconcile(draw.ranking.map((x) => x.publicId), d.units, d.waitlistSize, d.outcome);
check(rec.consistent !== false, rec.consistent === null ? "settlement still in progress" : "every recorded outcome follows from the recomputed ranking");
for (const p of rec.problems) console.log(`       ${p}`);

console.log(`\nWinners by your own computation: ${draw.winners.join(", ") || "none"}`);
if (d.negativeTest) console.log("This drop ran a labelled sandbox negative test: one payment failed on purpose.");
const sims = d.outcome.filter((o) => o.simulated).length;
if (sims) console.log(`${sims} of ${d.outcome.length} entrants are labelled simulated (no PayPal call).`);
console.log(failed ? `\n${failed} check(s) FAILED.\n` : "\nAll checks passed.\n");
console.log("What this can't show: that nobody edited the seed hash or the list before you first saw them. Save this output, or the /verify page, to compare later.\n");
process.exit(failed ? 1 : 0);
