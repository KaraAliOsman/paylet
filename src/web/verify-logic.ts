// Pure checks behind /verify: does what Paylet recorded follow from the draw you just recomputed?
// Rule: the first `units` entries of the ranking win; when a winner's payment fails, the unit passes to the next
// waitlisted entry (in ranking order), whose hold already exists. Everyone else must not be charged.

export interface Recorded {
  publicId: string;
  status: string;
  note?: string;
}

export interface ReconciledRow {
  rank: number;
  publicId: string;
  computed: { kind: "winner" | "waitlist" | "out"; n: number };
  recorded: Recorded | null;
  verdict: "ok" | "bad" | "pending";
  /** this winner's payment failed and the unit went to … */
  passedTo?: { publicId: string; waitlistN: number };
  /** this waitlisted entry took the unit of … */
  tookFrom?: string;
}

export interface Reconciliation {
  rows: ReconciledRow[];
  /** true / false, or null when nothing has been recorded yet */
  consistent: boolean | null;
  problems: string[];
}

const PAID = new Set(["captured", "won", "refunded"]);
const FAILED = new Set(["capture_failed"]);
const PENDING = new Set(["held", "authorizing", "waitlist"]);

/**
 * `outcome` may list every frozen entry (v2 contract) or only the paid / failed ones (older servers);
 * an entry without a record is treated as "not charged".
 */
export function reconcile(ranking: string[], units: number, waitlistSize: number, outcome: Recorded[]): Reconciliation {
  const rec = new Map(outcome.map((o) => [o.publicId, o]));
  const winners = ranking.slice(0, units);
  const waitlist = ranking.slice(units, units + waitlistSize);
  const queue = [...waitlist];
  const expectedPaid = new Set<string>();
  const passedTo = new Map<string, { publicId: string; waitlistN: number }>();
  const tookFrom = new Map<string, string>();

  const settle = (id: string) => {
    const st = rec.get(id)?.status;
    if (st && FAILED.has(st)) {
      const next = queue.shift();
      if (next) {
        passedTo.set(id, { publicId: next, waitlistN: waitlist.indexOf(next) + 1 });
        tookFrom.set(next, id);
        settle(next);
      }
    } else expectedPaid.add(id);
  };
  winners.forEach(settle);

  const problems: string[] = [];
  const rows: ReconciledRow[] = ranking.map((publicId, i) => {
    const computed: ReconciledRow["computed"] =
      i < units ? { kind: "winner", n: i + 1 } : i < units + waitlistSize ? { kind: "waitlist", n: i - units + 1 } : { kind: "out", n: 0 };
    const recorded = rec.get(publicId) ?? null;
    const st = recorded?.status;
    let verdict: ReconciledRow["verdict"] = "ok";
    if (passedTo.has(publicId)) verdict = "ok";
    else if (expectedPaid.has(publicId)) {
      if (st && PAID.has(st)) verdict = "ok";
      else if (st && PENDING.has(st)) verdict = "pending";
      else {
        verdict = "bad";
        problems.push(
          `${publicId} should have been charged (${computed.kind === "winner" ? `winner #${computed.n}` : `waitlist #${computed.n}`}) but is ${st ?? "not charged"}.`,
        );
      }
    } else if (st && (PAID.has(st) || FAILED.has(st))) {
      verdict = "bad";
      problems.push(`${publicId} was ${st === "capture_failed" ? "attempted" : "charged"} but your computation does not select it.`);
    }
    return { rank: i + 1, publicId, computed, recorded, verdict, passedTo: passedTo.get(publicId), tookFrom: tookFrom.get(publicId) };
  });

  const ranked = new Set(ranking);
  for (const o of outcome) {
    if (!ranked.has(o.publicId) && (PAID.has(o.status) || FAILED.has(o.status))) problems.push(`${o.publicId} was ${o.status} but is not in the frozen list.`);
  }

  const anyRecorded = outcome.length > 0;
  const consistent = problems.length > 0 ? false : !anyRecorded ? null : rows.some((r) => r.verdict === "pending") ? null : true;
  return { rows, consistent, problems };
}

/** drand quicknet: publication time of a round (genesis 1692803367, period 3 s). */
export const QUICKNET_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
export function quicknetRoundTime(round: number): number {
  return (1692803367 + (round - 1) * 3) * 1000;
}
