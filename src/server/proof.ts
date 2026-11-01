// P1-04: the permanent proof drop. scripts/proof-run.ts runs a real PayPal sandbox drop end to end against a running
// Paylet, then asks the server for a masked snapshot of it (GET /api/seller/:slug/export) and saves it as
// docs/proof-run.json. Free hosting wipes the database on every deploy, so the server re-imports that snapshot at boot
// whenever no proof drop exists. The snapshot holds public data only: public entry ids, statuses, amounts, the ledger
// with its (already masked) PayPal trace, the draw commitments, and PayPal ids masked to their last 4 characters.
// Never names, emails, addresses, payer ids, internal entry ids, or full PayPal ids.
import { existsSync, readFileSync } from "node:fs";
import { db, now, tx } from "./db";
import { formatUsd } from "../shared/money";
import { getDrop, id, listEntries, type DropRow } from "./models";
import { dropReport, type DropReport } from "./report";
import { maskId, toneOf, traceFromData, type Trace } from "./trace";
import type { PaypalCheck } from "./paypalcheck";

export const PROOF_VERSION = 1;

export interface ProofEntry {
  publicId: string;
  source: "human" | "agent" | "simulated";
  agentLabel: string | null;
  status: string;
  holdCents: number | null;
  capturedCents: number | null;
  refundedCents: number | null;
  /** masked PayPal authorization id ("…7K2Q") */
  authorization: string | null;
  payerVerified: boolean | null;
  shipping: { carrier: string; tracking: string } | null;
  note: string | null;
  explanation: string | null;
  createdAt: number;
  approvedAt: number | null;
  heldAt: number | null;
  settledAt: number | null;
  promotedAt: number | null;
}

export interface ProofSnapshot {
  version: number;
  exportedAt: number;
  drop: {
    slug: string;
    title: string;
    maker: string;
    blurb: string;
    art: string;
    priceCents: number;
    shipHoldCents: number;
    shipActualCents: number;
    units: number;
    waitlistSize: number;
    negativeTest: boolean;
    status: string;
    createdAt: number;
    closesAt: number;
    frozenAt: number | null;
    drawnAt: number | null;
    seed: string;
    seedHash: string;
    frozenHash: string | null;
    frozenList: string[];
    excluded: { publicId: string; reason: string }[];
    randomnessRound: number | null;
    randomnessValue: string | null;
    finalSeed: string | null;
  };
  entries: ProofEntry[];
  clusters: { kind: string; status: string; method: string; confidence: number; explanation: string; members: string[] }[];
  events: { ts: number; kind: string; message: string; real: 0 | 1; trace?: Trace; tone?: string }[];
  report: DropReport;
  paypalCheck: PaypalCheck | null;
}

/** Rejects anything that looks like PII or a full PayPal / internal id. Returns the problems found (empty = safe). */
export function auditSnapshot(json: string, extraSecrets: string[] = []): string[] {
  const problems: string[] = [];
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(json)) problems.push("an email address");
  if (/\bent_[0-9a-f]{8,}/.test(json)) problems.push("an internal entry id");
  // PayPal order / authorization / capture / refund ids are 17 upper-case letters and digits
  const ids = json.match(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{17}\b/g);
  if (ids) problems.push(`a full PayPal-like id (${ids[0].slice(0, 3)}…)`);
  for (const s of extraSecrets) if (s && s.length >= 6 && json.includes(s)) problems.push("a value from the private list");
  return problems;
}

const mask4 = (v: string | null | undefined) => (v ? (maskId(v) ?? null) : null);

/** Masked, PII-free snapshot of a finished drop (the seller console's "export"). */
export function exportProof(d: DropRow, paypalCheck: PaypalCheck | null): ProofSnapshot {
  const entries = listEntries(d.id);
  const pidOf = new Map(entries.map((e) => [e.id, e.public_id]));
  const events = db.prepare("SELECT ts, kind, message, real, data_json FROM events WHERE drop_id = ? ORDER BY id").all(d.id) as {
    ts: number;
    kind: string;
    message: string;
    real: 0 | 1;
    data_json: string | null;
  }[];
  const clusters = db.prepare("SELECT kind, status, method, confidence, explanation, member_ids FROM clusters WHERE drop_id = ?").all(d.id) as {
    kind: string;
    status: string;
    method: string;
    confidence: number;
    explanation: string;
    member_ids: string;
  }[];
  return {
    version: PROOF_VERSION,
    exportedAt: now(),
    drop: {
      slug: d.slug,
      title: d.title,
      maker: d.maker,
      blurb: d.blurb,
      art: d.art,
      priceCents: d.price_cents,
      shipHoldCents: d.ship_hold_cents,
      shipActualCents: d.ship_actual_cents,
      units: d.units,
      waitlistSize: d.waitlist_size,
      negativeTest: d.negative_test === 1,
      status: d.status,
      createdAt: d.created_at,
      closesAt: d.closes_at,
      frozenAt: d.frozen_at,
      drawnAt: d.drawn_at,
      // the seed is public once the drop is drawn (it is how anyone re-runs the draw)
      seed: d.status === "drawn" || d.status === "settled" ? d.seed : "",
      seedHash: d.seed_hash,
      frozenHash: d.frozen_hash,
      frozenList: JSON.parse(d.frozen_list ?? "[]") as string[],
      excluded: JSON.parse(d.excluded_json ?? "[]") as { publicId: string; reason: string }[],
      randomnessRound: d.randomness_round,
      randomnessValue: d.randomness_value,
      finalSeed: d.final_seed,
    },
    entries: entries.map((e) => ({
      publicId: e.public_id,
      source: e.source,
      agentLabel: e.agent_label,
      status: e.status,
      holdCents: e.hold_cents,
      capturedCents: e.captured_cents,
      refundedCents: e.refunded_cents,
      authorization: e.source === "simulated" ? null : mask4(e.authorization_id),
      payerVerified: e.payer_verified == null ? null : e.payer_verified === 1,
      shipping: e.tracking_number ? { carrier: e.carrier ?? "OTHER", tracking: mask4(e.tracking_number)! } : null,
      note: e.note,
      explanation: e.explanation,
      createdAt: e.created_at,
      approvedAt: e.approved_at,
      heldAt: e.held_at,
      settledAt: e.settled_at,
      promotedAt: e.promoted_at,
    })),
    clusters: clusters.map((c) => ({
      kind: c.kind,
      status: c.status,
      method: c.method,
      confidence: c.confidence,
      explanation: c.explanation,
      members: (JSON.parse(c.member_ids) as string[]).map((m) => pidOf.get(m) ?? "?"),
    })),
    events: events.map((e) => {
      const trace = traceFromData(e.data_json);
      const tone = toneOf(e.data_json);
      return { ts: e.ts, kind: e.kind, message: e.message, real: e.real, ...(trace ? { trace } : {}), ...(tone ? { tone } : {}) };
    }),
    report: dropReport(d),
    paypalCheck,
  };
}

/** Recreates a proof drop from a snapshot (kind 'proof', never drawn again, never expires). Idempotent by slug. */
export function importProof(snap: ProofSnapshot): DropRow | null {
  if (snap.version !== PROOF_VERSION) throw new Error(`unsupported proof snapshot version ${snap.version}`);
  const problems = auditSnapshot(JSON.stringify(snap));
  if (problems.length) throw new Error(`proof snapshot rejected: it contains ${problems.join(", ")}`);
  const existing = getDrop(snap.drop.slug);
  if (existing) return existing.kind === "proof" ? existing : null;
  const d = snap.drop;
  const dropId = id("drop", 6);
  const recorded = { paypalCheck: snap.paypalCheck, authorizations: Object.fromEntries(snap.entries.filter((e) => e.authorization).map((e) => [e.publicId, e.authorization])), exportedAt: snap.exportedAt };
  tx(() => {
    db.prepare(
      `INSERT INTO drops(id, slug, title, maker, blurb, art, price_cents, ship_hold_cents, ship_actual_cents, units, waitlist_size, closes_at, status, seed, seed_hash,
         frozen_hash, frozen_list, negative_test, seller_token, kind, created_at, drawn_at, frozen_at, excluded_json, randomness_round, randomness_value, final_seed, proof_json)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proof', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      dropId,
      d.slug,
      d.title,
      d.maker,
      d.blurb,
      d.art,
      d.priceCents,
      d.shipHoldCents,
      d.shipActualCents,
      d.units,
      d.waitlistSize,
      d.closesAt,
      d.status,
      d.seed,
      d.seedHash,
      d.frozenHash,
      JSON.stringify(d.frozenList),
      d.negativeTest ? 1 : 0,
      // nobody holds the seller key of an imported proof drop (the owner key still opens it)
      id("key", 12),
      d.createdAt,
      d.drawnAt,
      d.frozenAt,
      JSON.stringify(d.excluded),
      d.randomnessRound,
      d.randomnessValue,
      d.finalSeed,
      JSON.stringify(recorded),
    );
    const idOf = new Map<string, string>();
    for (const e of snap.entries) {
      const entryId = id("ent", 8);
      idOf.set(e.publicId, entryId);
      db.prepare(
        `INSERT INTO entries(id, public_id, drop_id, source, agent_label, status, hold_cents, captured_cents, refunded_cents, payer_hash, payer_verified, carrier, tracking_number,
           note, explanation, created_at, updated_at, approved_at, held_at, settled_at, promoted_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entryId,
        e.publicId,
        dropId,
        e.source,
        e.agentLabel,
        e.status,
        e.holdCents,
        e.capturedCents,
        e.refundedCents,
        // distinct payers stay distinct (Drop report), without any real payer id
        e.holdCents != null && e.status !== "duplicate" ? `proof:${e.publicId}` : null,
        e.payerVerified == null ? null : e.payerVerified ? 1 : 0,
        e.shipping?.carrier ?? null,
        e.shipping?.tracking ?? null,
        e.note,
        e.explanation,
        e.createdAt,
        e.settledAt ?? e.createdAt,
        e.approvedAt,
        e.heldAt,
        e.settledAt,
        e.promotedAt,
      );
    }
    for (const c of snap.clusters) {
      db.prepare("INSERT INTO clusters(id, drop_id, kind, status, method, confidence, evidence_json, explanation, member_ids, created_at) VALUES(?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)").run(
        id("clu", 6),
        dropId,
        c.kind,
        c.status,
        c.method,
        c.confidence,
        c.explanation,
        JSON.stringify(c.members.map((m) => idOf.get(m) ?? m)),
        d.createdAt,
      );
    }
    for (const ev of snap.events) {
      const data = ev.trace || ev.tone ? JSON.stringify({ ...(ev.trace ? { trace: ev.trace } : {}), ...(ev.tone ? { tone: ev.tone } : {}) }) : null;
      db.prepare("INSERT INTO events(drop_id, ts, kind, message, real, data_json) VALUES(?, ?, ?, ?, ?, ?)").run(dropId, ev.ts, ev.kind, ev.message, ev.real ? 1 : 0, data);
    }
  });
  return getDrop(dropId)!;
}

export function proofPath(): string {
  return process.env.PROOF_RUN_PATH ?? "docs/proof-run.json";
}

/** Boot: import docs/proof-run.json when the database has no proof drop (free hosting wipes it on every deploy). */
export function ensureProofDrop(path = proofPath()): DropRow | null {
  const have = db.prepare("SELECT * FROM drops WHERE kind = 'proof' ORDER BY created_at DESC LIMIT 1").get() as DropRow | undefined;
  if (have) return have;
  if (!existsSync(path)) return null;
  try {
    const d = importProof(JSON.parse(readFileSync(path, "utf8")) as ProofSnapshot);
    if (d) console.log(`[paylet] proof drop imported from ${path}: /d/${d.slug}`);
    return d;
  } catch (e) {
    console.warn("[paylet] proof drop not imported:", String(e).slice(0, 200));
    return null;
  }
}

/** What an imported proof run recorded (the PayPal check made at export time, masked authorization ids). */
export function recordedProof(d: DropRow): { paypalCheck: PaypalCheck | null; authorizations: Record<string, string>; exportedAt: number } | null {
  if (!d.proof_json) return null;
  try {
    return JSON.parse(d.proof_json);
  } catch {
    return null;
  }
}

/** GET /api/proof: the permanent proof drop and a one-line summary built from its Drop report. */
export function proofInfo(): { slug: string | null; summary: string | null; checkedAt: number | null } {
  const d = db.prepare("SELECT * FROM drops WHERE kind = 'proof' AND status = 'settled' ORDER BY created_at DESC LIMIT 1").get() as DropRow | undefined;
  if (!d) return { slug: null, summary: null, checkedAt: null };
  const r = dropReport(d);
  const entries = listEntries(d.id);
  const realOrders = entries.filter((e) => e.source !== "simulated").length;
  const recorded = recordedProof(d);
  const lastCheck = db.prepare("SELECT MAX(ts) t FROM events WHERE drop_id = ? AND kind = 'paypal_check'").get(d.id) as { t: number | null };
  const checkedAt = recorded?.paypalCheck?.checkedAt ?? lastCheck.t ?? null;
  const day = new Date(d.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const shipped = entries.filter((e) => e.source !== "simulated" && e.tracking_number).length;
  const refunded = entries.filter((e) => e.source !== "simulated" && e.status === "refunded").length;
  const parts = [
    `${realOrders} real PayPal orders`,
    r.agentRequests ? `${r.agentRequests} agent requests → ${r.agentHoldsWithoutPerson} holds without a person` : "",
    r.sameAccountDuplicates ? `${r.sameAccountDuplicates} same-account duplicate${r.sameAccountDuplicates === 1 ? "" : "s"} blocked` : "",
    r.networkAccounts ? `${r.networkAccounts} network accounts → ${r.networkTickets} ticket${r.networkTickets === 1 ? "" : "s"}` : "",
    r.failedPayments ? `${r.failedPayments} failed payment${r.failedPayments === 1 ? "" : "s"} passed to the waitlist` : "",
    r.capturedCents || r.shippingReleasedCents ? `partial capture ${formatUsd(r.capturedCents)} (${formatUsd(r.shippingReleasedCents)} of the hold released)` : "",
    shipped ? "tracking added in PayPal" : "",
    refunded ? `${refunded} refund${refunded === 1 ? "" : "s"}` : "",
    r.holdsVoided ? `${r.holdsVoided} hold${r.holdsVoided === 1 ? "" : "s"} voided` : "",
    `${formatUsd(r.chargedToLosersCents)} charged to anyone who lost`,
  ].filter(Boolean);
  const when = checkedAt ? ` Every hold checked with PayPal at ${new Date(checkedAt).toISOString().slice(0, 16).replace("T", " ")} UTC.` : "";
  return { slug: d.slug, summary: `A real PayPal sandbox run (${day}): ${parts.join(" · ")}.${when}`, checkedAt };
}
