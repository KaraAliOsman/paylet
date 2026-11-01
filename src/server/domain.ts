import { createHash, randomBytes } from "node:crypto";
import { db, now, tx } from "./db";
import { env } from "./env";
import { canonicalList, computeDraw, sha256Hex } from "../shared/draw";
import { DRAND_CHAIN_HASH, commitRound, fetchRoundWithRetries, finalSeedOf, roundTime, roundUrl } from "./drand";
import { formatUsd, fromPayPal } from "../shared/money";
import {
  emit,
  getDrop,
  getEntry,
  getEntryByOrder,
  hmac,
  id,
  listEntries,
  publicId,
  updateEntry,
  type ClusterRow,
  type DropRow,
  type EntryRow,
} from "./models";
import * as paypal from "./paypal";
import { enqueue, opCount, pendingOpsFor, type Handlers, type OpRow } from "./queue";
import type { Trace } from "./trace";
import { resolve, type ResolvedCluster as ResolvedClusterBase } from "./er/resolve";
import type { Identity } from "./er/normalize";
import { syntheticCrowd, type LabeledIdentity } from "./simulate";

/** P2-05 (workstream C): syntheticCrowd(seed, counts, tag, { window, simulated }) places every entrant inside the drop's
 *  window and labels it honestly. Called through this signature so it also runs against the 3-argument version. */
type CrowdFn = (
  seed: number,
  counts: Parameters<typeof syntheticCrowd>[1],
  tag: string,
  crowd: { window: { from: number; to: number }; simulated: true },
) => (LabeledIdentity & { ts?: number; agentLabel?: string | null })[];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- drops

export interface NewDrop {
  title: string;
  maker: string;
  blurb: string;
  art: string;
  priceCents: number;
  shipHoldCents: number;
  shipActualCents: number;
  units: number;
  minutesOpen: number;
  kind: "showcase" | "judge" | "proof";
  negativeTest?: boolean;
}

export async function createDrop(d: NewDrop): Promise<DropRow> {
  const seed = randomBytes(32).toString("hex");
  const dropId = id("drop", 6);
  const slug = `${d.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${dropId.slice(-4)}`;
  db.prepare(
    `INSERT INTO drops(id, slug, title, maker, blurb, art, price_cents, ship_hold_cents, ship_actual_cents, units, waitlist_size, closes_at, status, seed, seed_hash, seller_token, kind, negative_test, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?, 'open', ?, ?, ?, ?, ?, ?)`,
  ).run(
    dropId,
    slug,
    d.title,
    d.maker,
    d.blurb,
    d.art,
    d.priceCents,
    d.shipHoldCents,
    d.shipActualCents,
    d.units,
    now() + d.minutesOpen * 60_000,
    seed,
    await sha256Hex(seed),
    randomBytes(12).toString("hex"),
    d.kind,
    d.negativeTest ? 1 : 0,
    now(),
  );
  const drop = getDrop(dropId)!;
  emit(dropId, "drop_opened", `Drop opened: ${d.units} × "${d.title}" at ${formatUsd(d.priceCents)}. Seed commitment published.`, false, { seed_hash: drop.seed_hash });
  return drop;
}

export const SHOWCASE: NewDrop = {
  title: "Tidepool",
  maker: "Moth & Kiln Keycaps",
  blurb: "Hand-cast resin artisan keycap set — five sets, poured one at a time. One per person, agents welcome.",
  art: "tidepool",
  priceCents: 6500,
  shipHoldCents: 1200,
  shipActualCents: 750,
  units: 5,
  minutesOpen: 48 * 60,
  kind: "showcase",
  negativeTest: true,
};

export async function ensureShowcase(): Promise<DropRow> {
  const open = db.prepare("SELECT * FROM drops WHERE kind = 'showcase' AND status = 'open' AND closes_at > ? ORDER BY created_at DESC LIMIT 1").get(now()) as DropRow | undefined;
  return open ?? createDrop(SHOWCASE);
}

const revealed = (d: DropRow) => d.status === "drawn" || d.status === "settled";

/** PublicDrop.randomness: the committed drand round (value null until the reveal). Null for drops drawn without drand. */
export function randomnessOf(d: DropRow): { source: "drand-quicknet"; round: number; value: string | null; chainHash: string; url: string } | null {
  if (d.status === "open" || d.randomness_round == null) return null;
  return {
    source: "drand-quicknet",
    round: d.randomness_round,
    value: revealed(d) ? d.randomness_value : null,
    chainHash: DRAND_CHAIN_HASH,
    url: roundUrl(d.randomness_round),
  };
}

export function publicDrop(d: DropRow) {
  const entries = listEntries(d.id);
  const count = (s: (e: EntryRow) => boolean) => entries.filter(s).length;
  const real = (e: EntryRow) => e.source !== "simulated";
  const capturedReal = entries.filter((e) => real(e) && (e.status === "captured" || e.status === "refunded"));
  return {
    id: d.id,
    slug: d.slug,
    title: d.title,
    maker: d.maker,
    blurb: d.blurb,
    art: d.art,
    priceCents: d.price_cents,
    shipHoldCents: d.ship_hold_cents,
    shipActualCents: d.ship_actual_cents,
    units: d.units,
    closesAt: d.closes_at,
    status: d.status,
    kind: d.kind,
    seedHash: d.seed_hash,
    // the seed is revealed with the drand value (P2-10): commit → freeze → public randomness → reveal
    seed: revealed(d) ? d.seed : null,
    frozenHash: d.status === "open" ? null : d.frozen_hash,
    frozenList: d.status === "open" ? null : d.frozen_list ? (JSON.parse(d.frozen_list) as string[]) : null,
    waitlistSize: d.waitlist_size,
    randomness: randomnessOf(d),
    finalSeed: revealed(d) ? d.final_seed : null,
    pendingReviews: d.status === "open" ? pendingReviews(d.id).suggestions : 0,
    stats: {
      // real-only unless named *Simulated / simulated (contract: PublicDrop.stats)
      realOrders: count(real),
      /** @deprecated alias of realOrders, kept for older clients */
      requests: count(real),
      awaitingPerson: count((e) => e.status === "awaiting_person"),
      holds: count((e) => real(e) && e.hold_cents != null && e.status !== "duplicate"),
      duplicatesBlocked: count((e) => e.status === "duplicate"),
      agents: count((e) => e.source === "agent"),
      captured: capturedReal.length,
      // net of refunds: money PayPal still holds for the maker
      capturedCents: capturedReal.reduce((s, e) => s + (e.captured_cents ?? 0) - (e.refunded_cents ?? 0), 0),
      shippingReleasedCents: capturedReal.reduce((s, e) => s + Math.max(0, (e.hold_cents ?? 0) - (e.captured_cents ?? 0)), 0),
      voided: count((e) => real(e) && e.status === "voided"),
      refunded: count((e) => real(e) && e.status === "refunded"),
      failedPayments: count((e) => e.status === "capture_failed"),
      merged: count((e) => e.status === "merged"),
      simulated: count((e) => e.source === "simulated"),
      capturedSimulated: count((e) => e.source === "simulated" && e.status === "captured"),
    },
  };
}

// ---------------------------------------------------------------- entries

function dropIsOpen(d: DropRow): boolean {
  return d.status === "open" && d.closes_at > now();
}

export async function startEntry(dropIdOrSlug: string, source: "human" | "agent", agentLabel?: string) {
  const drop = getDrop(dropIdOrSlug);
  if (!drop) throw new HttpError(404, "drop_not_found");
  if (!dropIsOpen(drop)) throw new HttpError(409, "drop_closed");
  const entryId = id("ent", 8);
  const pid = publicId();
  db.prepare(
    `INSERT INTO entries(id, public_id, drop_id, source, agent_label, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, 'awaiting_person', ?, ?)`,
  ).run(entryId, pid, drop.id, source, agentLabel ?? null, now(), now());
  const base = env.PUBLIC_URL.replace(/\/$/, "");
  const { orderId, approveUrl, trace } = await paypal.createHoldOrder({
    dropId: drop.id,
    entryId,
    title: drop.title,
    sku: drop.slug.slice(0, 120),
    priceCents: drop.price_cents,
    shipHoldCents: drop.ship_hold_cents,
    returnUrl: `${base}/return?entry=${entryId}`,
    cancelUrl: `${base}/return?entry=${entryId}&cancelled=1`,
  });
  updateEntry(entryId, { order_id: orderId, approve_url: approveUrl ?? null });
  emit(
    drop.id,
    "order_created",
    source === "agent"
      ? `Agent "${agentLabel ?? "unnamed"}" requested entry ${pid} → PayPal approval link issued; agent stops here (it cannot pay).`
      : `Fan opened PayPal for entry ${pid} (hold of ${formatUsd(drop.price_cents + drop.ship_hold_cents)} requested).`,
    true,
    { trace },
  );
  return { entryId, publicId: pid, orderId, approveUrl, drop };
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

export type FinalizeOutcome = "authorizing" | "duplicate" | "not_approved" | "closed" | "already" | "unknown_order";

/** Called after the person approves in PayPal (button onApprove, agent return URL, webhook, or sweeper).
 *  Every state change is a conditional UPDATE, so concurrent callers and a concurrent draw can never
 *  move an entry backwards or create a hold outside the ballot. */
export async function finalize(orderId: string, opts: { quiet?: boolean } = {}): Promise<{ outcome: FinalizeOutcome; entry?: EntryRow }> {
  const entry = getEntryByOrder(orderId);
  if (!entry) return { outcome: "unknown_order" };
  if (entry.status !== "awaiting_person") return { outcome: "already", entry };
  // PayPal declined the funding source at authorize time: the order still reads APPROVED, so background re-checks
  // must wait for the person to approve again (return URL, JS SDK onApprove or a new CHECKOUT.ORDER.APPROVED webhook).
  if (opts.quiet && entry.needs_reapproval) return { outcome: "not_approved", entry };

  const ident = await paypal.getOrderIdentity(orderId);
  // re-read after the await: the drop may have been drawn meanwhile
  const drop = getDrop(entry.drop_id)!;
  if (!opts.quiet || ident.status === "APPROVED") emit(drop.id, "order_checked", `GET order for ${entry.public_id}: ${ident.status}`, true, { trace: ident.trace });
  if (ident.status !== "APPROVED") return { outcome: "not_approved", entry };
  if (!dropIsOpen(drop)) {
    db.prepare("UPDATE entries SET status = 'expired', note = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_person'").run(
      "Approved after the drop closed — no hold was placed.",
      now(),
      entry.id,
    );
    return { outcome: "closed", entry: getEntry(entry.id) };
  }

  const anchor = ident.payerId ?? ident.accountId;
  if (!anchor) {
    db.prepare("UPDATE entries SET status = 'error', note = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_person'").run("PayPal returned no payer id", now(), entry.id);
    return { outcome: "not_approved", entry: getEntry(entry.id) };
  }
  const name = ident.name ?? null;
  const fields = [
    hmac(`payer:${anchor}`),
    ident.accountId ? hmac(`acct:${ident.accountId}`) : null,
    ident.email ? hmac(`email:${ident.email.toLowerCase()}`) : null,
    name,
    name ? `${name.split(" ")[0]} ${(name.split(" ")[1] ?? "").slice(0, 1)}.`.trim() : null,
    ident.email ?? null,
    ident.address ? JSON.stringify(ident.address) : null,
  ] as const;

  let changed = 0;
  try {
    changed = Number(
      db
        .prepare(
          `UPDATE entries SET payer_hash = ?, account_hash = ?, email_hash = ?, name = ?, display_name = ?, email = ?, address_json = ?, status = 'authorizing',
             payer_verified = ?, approved_at = ?, needs_reapproval = NULL, updated_at = ?
           WHERE id = ? AND status = 'awaiting_person' AND EXISTS (SELECT 1 FROM drops WHERE id = ? AND status = 'open' AND closes_at > ?)`,
        )
        .run(...fields, payerVerified(ident.accountStatus), now(), now(), entry.id, drop.id, now()).changes,
    );
  } catch (e) {
    if (!String(e).includes("UNIQUE")) throw e;
    const dup = db
      .prepare(
        `UPDATE entries SET account_hash = ?, email_hash = ?, name = ?, display_name = ?, email = ?, address_json = ?, status = 'duplicate', note = ?, updated_at = ?
         WHERE id = ? AND status = 'awaiting_person'`,
      )
      .run(fields[1], fields[2], fields[3], fields[4], fields[5], fields[6], "This PayPal account already holds an entry in this drop — no hold placed.", now(), entry.id);
    if (dup.changes) {
      emit(drop.id, "duplicate_blocked", `Entry ${entry.public_id}: same PayPal account as an existing entry → no hold placed.`, true, { source: entry.source });
      return { outcome: "duplicate", entry: getEntry(entry.id) };
    }
    return { outcome: "already", entry: getEntry(entry.id) };
  }
  if (!changed) {
    // someone else finalized it, or the drop closed between our checks
    const fresh = getEntry(entry.id)!;
    if (fresh.status === "awaiting_person") {
      db.prepare("UPDATE entries SET status = 'expired', note = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_person'").run(
        "Approved after the drop closed — no hold was placed.",
        now(),
        entry.id,
      );
      return { outcome: "closed", entry: getEntry(entry.id) };
    }
    return { outcome: "already", entry: fresh };
  }
  // a re-approval after a declined funding source needs a fresh PayPal-Request-Id (the first one is spent)
  const tries = opCount(entry.id, "authorize");
  enqueue("authorize", tries ? `auth:${entry.id}:${tries + 1}` : `auth:${entry.id}`, entry.id);
  return { outcome: "authorizing", entry: getEntry(entry.id) };
}

/** PayPal wallet account_status → payer_verified (KYA-lite, P2-16): 1 VERIFIED, 0 UNVERIFIED, null if PayPal did not say. */
export function payerVerified(accountStatus: string | undefined): number | null {
  if (!accountStatus) return null;
  return accountStatus.toUpperCase() === "VERIFIED" ? 1 : 0;
}

// ---------------------------------------------------------------- simulated crowd

export function addSimulatedCrowd(dropIdOrSlug: string, seed = Math.floor(Math.random() * 1e6)) {
  const drop = getDrop(dropIdOrSlug);
  if (!drop) throw new HttpError(404, "drop_not_found");
  if (!dropIsOpen(drop)) throw new HttpError(409, "drop_closed");
  const sims = (db.prepare("SELECT COUNT(*) n FROM entries WHERE drop_id = ? AND source = 'simulated'").get(drop.id) as { n: number }).n;
  if (sims >= 60) throw new HttpError(409, "sim_limit", "This drop already has its simulated crowd.");
  const t = now();
  const window = { from: drop.created_at, to: t };
  const crowd = (syntheticCrowd as unknown as CrowdFn)(seed, { fans: 12, networks: 1, netSize: 6, households: 1, neighbors: 1, namesakes: 1 }, `sim${seed}`, { window, simulated: true });
  // The older simulate.ts gives people no timestamp and a bot network fixed 2023 ones: keep everyone inside the drop's
  // window anyway (never before it opened). People are spread over it; an out-of-window burst keeps its spacing, ending now.
  const inWindow = (ts: number) => ts >= window.from && ts <= window.to;
  const lastOutside = Math.max(0, ...crowd.map((p) => (p.ts != null && !inWindow(p.ts) ? p.ts : 0)));
  const tsOf = (p: { ts?: number }, i: number) =>
    p.ts == null ? Math.round(window.from + ((i + 1) / (crowd.length + 1)) * (window.to - window.from)) : inWindow(p.ts) ? p.ts : Math.max(window.from, window.to - (lastOutside - p.ts));
  for (const [i, p] of crowd.entries()) {
    const entryId = id("ent", 8);
    db.prepare(
      `INSERT INTO entries(id, public_id, drop_id, source, agent_label, status, payer_hash, name, display_name, email, address_json, hold_cents, authorization_id, created_at, updated_at, note)
       VALUES(?, ?, ?, 'simulated', ?, 'held', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Simulated entrant — no PayPal call.')`,
    ).run(
      entryId,
      publicId(),
      drop.id,
      p.agentLabel ?? (p.kind === "reshipper_network" ? "simulated-scalper-bot" : null),
      hmac(`sim:${p.id}`),
      p.name,
      `${p.name.split(" ")[0]} ${(p.name.split(" ")[1] ?? "").slice(0, 1)}.`,
      p.email ?? null,
      JSON.stringify(p.address),
      drop.price_cents + drop.ship_hold_cents,
      `SIM-${entryId.slice(-8).toUpperCase()}`,
      tsOf(p, i),
      t,
    );
  }
  emit(drop.id, "simulated_crowd", `Added ${crowd.length} simulated entrants (labelled; no PayPal calls) to show allocation at scale.`, false);
  return crowd.length;
}

// ---------------------------------------------------------------- entity resolution

function identityOf(e: EntryRow): Identity | null {
  if (!e.address_json) return null;
  return {
    id: e.id,
    label: e.public_id,
    name: e.name ?? "",
    email: e.email,
    address: JSON.parse(e.address_json),
    ts: e.created_at,
    // honest provenance for the model and the rules: a simulated entrant is "simulated" (a scripted bot keeps its label)
    source: e.source,
    agentLabel: e.agent_label,
  };
}

const analyzing = new Set<string>();

/** What workstream C's resolve() adds over the original result (optional here, so both versions compile). */
interface ResolveExtras {
  keptApart?: { a: string; b: string; reason: string; confidence: number }[];
  degraded?: string | null;
}
type ClusterExtras = { normalizedKey?: string | null };

export interface KeptApartView {
  a: string;
  b: string;
  reason: string;
  confidence: number;
}

/** AiSummary (contract): the latest AI review of a drop, with public ids only. */
export function aiSummary(dropId: string) {
  const r = db.prepare("SELECT * FROM ai_reviews WHERE drop_id = ?").get(dropId) as
    | { ran_at: number; model: string; uncertain_pairs: number; linked: number; kept_apart_json: string; degraded: string | null }
    | undefined;
  const keptApart = r ? (JSON.parse(r.kept_apart_json) as KeptApartView[]) : [];
  return {
    model: r?.model ?? env.AI_MODEL,
    ranAt: r?.ran_at ?? null,
    uncertainPairs: r?.uncertain_pairs ?? 0,
    linked: r?.linked ?? 0,
    keptApartCount: keptApart.length,
    keptApart: keptApart.slice(0, 5),
    degraded: r?.degraded ?? null,
  };
}

export async function analyzeDrop(dropIdOrSlug: string) {
  const drop = getDrop(dropIdOrSlug);
  if (!drop) throw new HttpError(404, "drop_not_found");
  if (drop.status !== "open") throw new HttpError(409, "drop_closed", "This drop is already closed: the AI review can no longer change the draw.");
  if (analyzing.has(drop.id)) throw new HttpError(409, "analysis_running", "An AI review is already running for this drop.");
  const entries = listEntries(drop.id).filter((e) => e.status === "held" || e.status === "authorizing");
  if (entries.length > 300) throw new HttpError(413, "too_many_entries");
  const identities = entries.map(identityOf).filter((x): x is Identity => !!x);
  const t0 = Date.now();
  analyzing.add(drop.id);
  let result: Awaited<ReturnType<typeof resolve>> & ResolveExtras;
  try {
    result = await resolve(identities, { useLlm: true });
  } finally {
    analyzing.delete(drop.id);
  }
  const ms = Date.now() - t0;
  // resolve() reports pairs by public label; map any internal id defensively so only public ids ever leave the server
  const pidOf = new Map(listEntries(drop.id).map((e) => [e.id, e.public_id]));
  const keptApart: KeptApartView[] = (result.keptApart ?? []).map((k) => ({
    a: pidOf.get(k.a) ?? k.a,
    b: pidOf.get(k.b) ?? k.b,
    reason: String(k.reason ?? "").slice(0, 240),
    confidence: Number(k.confidence) || 0,
  }));
  const degraded = result.degraded !== undefined ? result.degraded : result.aiDegraded ? `AI unavailable (${result.aiDegraded}). Showing rule-only suggestions.` : null;
  const linked = result.clusters.filter((c) => c.method === "ai").length;
  tx(() => {
    // replace previous suggestions (keep seller decisions)
    db.prepare("DELETE FROM clusters WHERE drop_id = ? AND status = 'suggested'").run(drop.id);
    const decided = db.prepare("SELECT member_ids FROM clusters WHERE drop_id = ? AND status <> 'suggested'").all(drop.id) as { member_ids: string }[];
    const decidedKeys = new Set(decided.map((d) => JSON.parse(d.member_ids).sort().join(",")));
    for (const c of result.clusters as (ResolvedClusterBase & ClusterExtras)[]) {
      if (decidedKeys.has([...c.memberIds].sort().join(","))) continue;
      db.prepare(
        `INSERT INTO clusters(id, drop_id, kind, status, method, confidence, evidence_json, explanation, member_ids, normalized_key, created_at) VALUES(?, ?, ?, 'suggested', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id("clu", 6), drop.id, c.kind, c.method, c.confidence, JSON.stringify(c.evidence), c.explanation, JSON.stringify(c.memberIds), c.normalizedKey ?? null, now());
    }
    db.prepare(
      `INSERT INTO ai_reviews(drop_id, ran_at, model, uncertain_pairs, linked, llm_calls, kept_apart_json, degraded, ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(drop_id) DO UPDATE SET ran_at = excluded.ran_at, model = excluded.model, uncertain_pairs = excluded.uncertain_pairs, linked = excluded.linked,
         llm_calls = excluded.llm_calls, kept_apart_json = excluded.kept_apart_json, degraded = excluded.degraded, ms = excluded.ms`,
    ).run(drop.id, now(), env.AI_MODEL, result.uncertainPairs, linked, result.llmCalls, JSON.stringify(keptApart), degraded, ms);
  });
  const pending = pendingReviews(drop.id).suggestions;
  emit(
    drop.id,
    "er_done",
    degraded
      ? `${/[.!?]$/.test(degraded) ? degraded : `${degraded}.`} ${plural(pending, "group")} ${pending === 1 ? "needs" : "need"} the seller's decision. Nothing merges until the seller confirms.`
      : `AI reviewed ${plural(result.uncertainPairs, "uncertain pair")} in ${(ms / 1000).toFixed(1)} s: ${plural(pending, "group")} ${pending === 1 ? "needs" : "need"} the seller's decision${keptApart.length ? `, ${plural(keptApart.length, "pair")} kept apart` : ""}. Nothing merges until the seller confirms.`,
    false,
    degraded ? { tone: "warn" } : undefined,
  );
  return { ...result, keptApart: keptApart.slice(0, 5), degraded, ms };
}

export function decideCluster(dropId: string, clusterId: string, decision: "confirmed" | "dismissed") {
  const c = db.prepare("SELECT * FROM clusters WHERE id = ? AND drop_id = ?").get(clusterId, dropId) as ClusterRow | undefined;
  if (!c) throw new HttpError(404, "cluster_not_found");
  const d = getDrop(dropId)!;
  if (d.status !== "open") throw new HttpError(409, "drop_closed");
  db.prepare("UPDATE clusters SET status = ? WHERE id = ? AND drop_id = ?").run(decision, clusterId, dropId);
  emit(c.drop_id, "cluster_" + decision, clusterDecisionMessage(c.kind, (JSON.parse(c.member_ids) as string[]).length, decision), false);
}

/** "Seller confirmed a reseller network of 6 PayPal accounts: they now share one ticket." */
export function clusterDecisionMessage(kind: ClusterRow["kind"], n: number, decision: "confirmed" | "dismissed"): string {
  const what = kind === "operator" ? "reseller network" : "household";
  return decision === "confirmed"
    ? `Seller confirmed a ${what} of ${n} PayPal accounts: they now share one ticket.`
    : `Seller dismissed the suggested ${what} of ${n} PayPal accounts: each keeps its own ticket.`;
}

/** Contract `Cluster` (seller console). Member ids are internal entry ids, like SellerEntry.id. */
export function listClusters(dropId: string) {
  return (db.prepare("SELECT * FROM clusters WHERE drop_id = ? ORDER BY CASE kind WHEN 'operator' THEN 0 ELSE 1 END, confidence DESC").all(dropId) as unknown as ClusterRow[]).map((c) => ({
    id: c.id,
    kind: c.kind,
    status: c.status,
    method: c.method,
    confidence: c.confidence,
    evidence: JSON.parse(c.evidence_json) as { field: string; detail: string }[],
    explanation: c.explanation,
    memberIds: JSON.parse(c.member_ids) as string[],
    normalizedKey: c.normalized_key ?? null,
    createdAt: c.created_at,
  }));
}

// ---------------------------------------------------------------- draw & settlement
// Two phases (P2-10):
//   FREEZE: guards (holds still being placed, AI suggestions not reviewed, nobody to draw), confirmed groups merged,
//           the eligible list hashed and published with every exclusion, and a FUTURE drand round committed.
//   REVEAL: once that round is published, final seed = SHA-256(seed:randomness), winners computed, money moves.
// Every step that decides who is in runs synchronously (no await between the checks and the conditional UPDATE),
// so a concurrent approval can never slip a hold into, or out of, a list that is being frozen or drawn.

const sha256Sync = (s: string) => createHash("sha256").update(s).digest("hex");
const roundLabel = (r: number) => r.toLocaleString("en-US");

/** Seller decisions are owed on AI suggestions that still change the draw (at least two members holding a ticket). */
export function pendingReviews(dropId: string): { suggestions: number; accounts: number } {
  const live = new Set(
    listEntries(dropId)
      .filter((e) => e.status === "held" || e.status === "authorizing")
      .map((e) => e.id),
  );
  const rows = db.prepare("SELECT member_ids FROM clusters WHERE drop_id = ? AND status = 'suggested'").all(dropId) as { member_ids: string }[];
  const accounts = new Set<string>();
  let suggestions = 0;
  for (const r of rows) {
    const members = (JSON.parse(r.member_ids) as string[]).filter((m) => live.has(m));
    if (members.length < 2) continue;
    suggestions++;
    for (const m of members) accounts.add(m);
  }
  return { suggestions, accounts: accounts.size };
}

export function pendingReviewsMessage(p: { suggestions: number; accounts: number }): string {
  return `${plural(p.suggestions, "AI suggestion")} ${p.suggestions === 1 ? "is" : "are"} still pending: ${p.accounts} accounts would each keep a ticket. Review ${p.suggestions === 1 ? "it" : "them"} first.`;
}

/** After closing time the seller still gets this long to decide pending AI suggestions before the automatic draw. */
export const REVIEW_GRACE_MS = 15 * 60_000;
/** drand unreachable for this long after the freeze: draw with the committed seed alone (said in the ledger). */
export const DRAND_GIVE_UP_MS = 15 * 60_000;
const MAX_DRAND_HOPS = 2;

export interface DrawOptions {
  /** skip the "pending AI suggestions" guard (never for judge drops) */
  force?: boolean;
  /** the automatic draw at closing time (sweeper) */
  auto?: boolean;
}

export interface FreezeResult {
  status: "frozen" | "settled";
  dropId: string;
  frozenHash: string;
  eligible: number;
  excluded: { publicId: string; reason: "merged" | "duplicate" }[];
  round: number | null;
  revealAt: number | null;
}

/** Phase 1. Throws 409 holds_pending / pending_reviews / no_eligible_entries / already_drawn. */
export async function freeze(dropIdOrSlug: string, opts: DrawOptions = {}): Promise<FreezeResult> {
  const drop = getDrop(dropIdOrSlug);
  if (!drop) throw new HttpError(404, "drop_not_found");
  if (drop.status !== "open") throw new HttpError(409, "already_drawn", "This drop was already closed and drawn.");
  const entries = listEntries(drop.id);
  const pendingAuth = entries.filter((e) => e.status === "authorizing").length;
  if (pendingAuth) throw new HttpError(409, "holds_pending", `${plural(pendingAuth, "hold")} still being placed by PayPal. Try again in a few seconds.`);
  const held = entries.filter((e) => e.status === "held");
  if (!held.length) {
    if (opts.auto) return closeEmpty(drop);
    throw new HttpError(409, "no_eligible_entries", "Nobody holds a ticket in this drop yet, so there is nothing to draw. Nothing was closed.");
  }
  const pending = pendingReviews(drop.id);
  const skipReview = Boolean(opts.auto || (opts.force && drop.kind !== "judge"));
  if (pending.suggestions && !skipReview) {
    throw new HttpError(409, "pending_reviews", pendingReviewsMessage(pending) + (opts.force ? " Judge drops can't skip the review." : ""));
  }

  // Confirmed groups: one ticket per group (the earliest entry keeps it).
  const confirmed = (db.prepare("SELECT * FROM clusters WHERE drop_id = ? AND status = 'confirmed'").all(drop.id) as unknown as ClusterRow[]).map((c) => ({
    ...c,
    ids: JSON.parse(c.member_ids) as string[],
  }));
  const merged = new Map<string, { clusterId: string; kind: ClusterRow["kind"]; others: number }>();
  const keepers = new Map<string, string>();
  for (const c of confirmed) {
    const members = held.filter((e) => c.ids.includes(e.id)).sort((a, b) => a.created_at - b.created_at);
    for (const m of members.slice(1)) if (!merged.has(m.id)) merged.set(m.id, { clusterId: c.id, kind: c.kind, others: members.length - 1 });
    if (members[0] && !merged.has(members[0].id)) keepers.set(members[0].id, c.id);
  }
  const eligible = held.filter((e) => !merged.has(e.id));
  const ids = eligible.map((e) => e.public_id);
  const frozenHash = sha256Sync(canonicalList(ids));
  const excluded: FreezeResult["excluded"] = [
    ...held.filter((e) => merged.has(e.id)).map((e) => ({ publicId: e.public_id, reason: "merged" as const })),
    ...entries.filter((e) => e.status === "duplicate").map((e) => ({ publicId: e.public_id, reason: "duplicate" as const })),
  ];
  const t = now();
  const round = commitRound(t);
  const closed = db
    .prepare(
      `UPDATE drops SET status = 'frozen', frozen_at = ?, frozen_hash = ?, frozen_list = ?, excluded_json = ?, randomness_round = ?, randomness_value = NULL,
         randomness_hops = 0, final_seed = NULL WHERE id = ? AND status = 'open'`,
    )
    .run(t, frozenHash, JSON.stringify([...ids].sort()), JSON.stringify(excluded), round, drop.id);
  if (!closed.changes) throw new HttpError(409, "already_drawn", "This drop was already closed and drawn.");

  for (const [entryId, m] of merged) {
    const what = m.kind === "operator" ? "reseller network" : "household";
    updateEntry(entryId, {
      status: "merged",
      cluster_id: m.clusterId,
      // templated on purpose: the fan never sees free-form model text or other people's details
      explanation: `The seller confirmed that this PayPal account belongs to the same ${m.kind === "operator" ? "shipping operation" : "household"} as ${plural(m.others, "other entry", "other entries")} (shared delivery address). One ticket per ${m.kind === "operator" ? "operation" : "household"}: your hold is released, nothing was charged.`,
      note: `Merged into a confirmed ${what}: hold released, nothing charged.`,
    });
  }
  for (const [entryId, clusterId] of keepers) updateEntry(entryId, { cluster_id: clusterId });
  // Pending approvals that never completed simply expire (no hold exists).
  for (const e of entries.filter((x) => x.status === "awaiting_person")) {
    updateEntry(e.id, { status: "expired", note: e.source === "agent" ? "No person approved in PayPal: no hold was placed." : "Not approved in PayPal before the draw: no hold was placed." });
  }
  const mergedEntries = held.filter((e) => merged.has(e.id)).map((e) => getEntry(e.id)!);
  for (const e of mergedEntries.filter((x) => x.source !== "simulated")) scheduleVoid(drop, e, "merged into a confirmed group");
  releaseSimulated(drop, mergedEntries.filter((x) => x.source === "simulated"), "merged into a confirmed group");

  if (pending.suggestions) {
    emit(
      drop.id,
      "review_skipped",
      `${opts.auto ? "Closing time: drawn automatically." : "The seller drew without reviewing."} ${plural(pending.suggestions, "AI suggestion")} ${pending.suggestions === 1 ? "was" : "were"} not reviewed before the draw, so those ${pending.accounts} accounts keep their own tickets.`,
      false,
      { tone: "warn" },
    );
  }
  const dupes = excluded.filter((x) => x.reason === "duplicate").length;
  const exclusions = [mergedEntries.length ? `${mergedEntries.length} merged into confirmed groups` : "", dupes ? plural(dupes, "same-account duplicate") : ""].filter(Boolean).join(", ");
  emit(
    drop.id,
    "frozen",
    `List frozen: ${plural(ids.length, "eligible entry", "eligible entries")} (SHA-256 ${frozenHash.slice(0, 12)}…)${exclusions ? `; excluded: ${exclusions}` : ""}. The winners come from drand round ${roundLabel(round)}, published about ${Math.max(1, Math.round((roundTime(round) - t) / 1000))} s from now, after the freeze.`,
    false,
    { frozenHash, round },
  );
  return { status: "frozen", dropId: drop.id, frozenHash, eligible: ids.length, excluded, round, revealAt: roundTime(round) };
}

/** Closing time with nobody holding a ticket: nothing to draw, nobody charged. */
function closeEmpty(drop: DropRow): FreezeResult {
  const hash = sha256Sync(canonicalList([]));
  const t = now();
  const ch = db
    .prepare("UPDATE drops SET status = 'settled', frozen_at = ?, drawn_at = ?, frozen_hash = ?, frozen_list = '[]', excluded_json = '[]', randomness_round = NULL WHERE id = ? AND status = 'open'")
    .run(t, t, hash, drop.id);
  if (ch.changes) {
    for (const e of listEntries(drop.id).filter((x) => x.status === "awaiting_person")) {
      updateEntry(e.id, { status: "expired", note: e.source === "agent" ? "No person approved in PayPal: no hold was placed." : "Not approved in PayPal before the drop closed: no hold was placed." });
    }
    emit(drop.id, "settled", "Closing time: nobody held a ticket, so there was nothing to draw. Nobody was charged.", false);
  }
  return { status: "settled", dropId: drop.id, frozenHash: hash, eligible: 0, excluded: [], round: null, revealAt: null };
}

export interface RevealResult {
  winners: string[];
  waitlist: string[];
  round: number | null;
  finalSeed: string | null;
}

const reveals = new Map<string, Promise<RevealResult | null>>();
const revealRetryAt = new Map<string, number>();
const drandWaitWarned = new Set<string>();

/** Starts (or joins) the reveal of a frozen drop. Never rejects: failures are logged and retried by the sweeper. */
export function scheduleReveal(dropId: string): Promise<RevealResult | null> {
  const running = reveals.get(dropId);
  if (running) return running;
  const p = reveal(dropId)
    .catch((e) => {
      console.warn("[paylet] reveal", dropId, String(e).slice(0, 200));
      revealRetryAt.set(dropId, now() + 60_000);
      return null;
    })
    .finally(() => reveals.delete(dropId));
  reveals.set(dropId, p);
  return p;
}

/** The reveal in flight for a drop (tests, scripts). */
export function whenRevealed(dropId: string): Promise<RevealResult | null> {
  return reveals.get(dropId) ?? Promise.resolve(null);
}

/** Phase 2: wait for the committed drand round, fetch it (3 tries; then the next round, said in the ledger), draw, settle. */
async function reveal(dropId: string): Promise<RevealResult | null> {
  let drop = getDrop(dropId);
  if (!drop || drop.status !== "frozen") return null;
  let round = drop.randomness_round;
  let value: string | null = null;
  while (round != null) {
    const beacon = await fetchRoundWithRetries(round);
    drop = getDrop(dropId)!;
    if (drop.status !== "frozen") return null;
    if (beacon) {
      value = beacon.randomness;
      break;
    }
    if ((drop.randomness_hops ?? 0) < MAX_DRAND_HOPS) {
      db.prepare("UPDATE drops SET randomness_round = ?, randomness_hops = randomness_hops + 1 WHERE id = ? AND status = 'frozen'").run(round + 1, dropId);
      emit(
        dropId,
        "drand_next_round",
        `drand round ${roundLabel(round)} could not be fetched after 3 tries, so the draw uses the next round, ${roundLabel(round + 1)} (also published after the freeze).`,
        false,
        { tone: "warn" },
      );
      round += 1;
      continue;
    }
    if (now() - (drop.frozen_at ?? now()) < DRAND_GIVE_UP_MS) {
      if (!drandWaitWarned.has(dropId)) {
        drandWaitWarned.add(dropId);
        emit(
          dropId,
          "drand_unreachable",
          "drand is unreachable right now. The list stays frozen and Paylet retries every minute; it only draws without public randomness after 15 minutes, and says so here.",
          false,
          { tone: "warn" },
        );
      }
      revealRetryAt.set(dropId, now() + 60_000);
      return null;
    }
    // Never silently: the ledger says the draw fell back to the committed seed alone.
    db.prepare("UPDATE drops SET randomness_round = NULL, randomness_value = NULL WHERE id = ? AND status = 'frozen'").run(dropId);
    emit(
      dropId,
      "drand_fallback",
      "drand was unreachable for 15 minutes, so this draw uses the committed seed alone. That is weaker: Paylet knew the seed before the list was frozen.",
      false,
      { tone: "warn" },
    );
    round = null;
  }
  drop = getDrop(dropId)!;
  if (drop.status !== "frozen") return null;
  const finalSeed = value ? finalSeedOf(drop.seed, value) : null;
  const ids = JSON.parse(drop.frozen_list ?? "[]") as string[];
  const result = await computeDraw(finalSeed ?? drop.seed, ids, drop.units, drop.waitlist_size);

  // --- synchronous from here: status, outcome and every scheduled money movement
  const opened = db
    .prepare("UPDATE drops SET status = 'drawn', drawn_at = ?, randomness_value = ?, final_seed = ? WHERE id = ? AND status = 'frozen'")
    .run(now(), value, finalSeed, dropId);
  if (!opened.changes) return null;
  revealRetryAt.delete(dropId);
  drandWaitWarned.delete(dropId);
  drop = getDrop(dropId)!;
  const byPid = new Map(listEntries(dropId).map((e) => [e.public_id, e]));
  const stillHeld = (pid: string) => byPid.get(pid)?.status === "held";
  if (value && round != null) {
    emit(
      dropId,
      "randomness",
      `Randomness: League of Entropy drand round ${roundLabel(round)}, published after the list was frozen. Not even Paylet knew the winners in advance.`,
      false,
      { round, value },
    );
  }
  const winners = result.winners.filter(stillHeld);
  const lostHold = result.winners.filter((pid) => !stillHeld(pid));
  const waitlist = result.waitlist.filter(stillHeld);
  const losers = ids.filter((pid) => stillHeld(pid) && !result.winners.includes(pid) && !result.waitlist.includes(pid));
  // 1) every status first (settlement bookkeeping never sees a half-drawn drop) …
  for (const pid of winners) updateEntry(byPid.get(pid)!.id, { status: "won" });
  for (const pid of waitlist) updateEntry(byPid.get(pid)!.id, { status: "waitlist" });
  for (const pid of losers) updateEntry(byPid.get(pid)!.id, { status: "lost" });
  emit(
    dropId,
    "draw",
    `Seed revealed. ${plural(winners.length, "winner")}, ${waitlist.length} on the waitlist. Settling with PayPal…`,
    false,
    { finalSeed, seed: drop.seed },
  );
  // 2) … then move money.
  // Sandbox negative test: one winner's payment fails so the waitlist hand-off is visible. Prefer a simulated winner
  // (so a real person's hold is captured normally); only if every winner is real does a real hold get the PayPal 422.
  const failPid = drop.negative_test === 1 ? (winners.find((p) => byPid.get(p)!.source === "simulated") ?? winners[0]) : null;
  for (const pid of winners) scheduleCapture(drop, getEntry(byPid.get(pid)!.id)!, pid === failPid);
  const loserRows = losers.map((pid) => getEntry(byPid.get(pid)!.id)!);
  for (const e of loserRows.filter((x) => x.source !== "simulated")) scheduleVoid(drop, e, "not selected");
  releaseSimulated(drop, loserRows.filter((x) => x.source === "simulated"), "not selected");
  // a winner whose hold disappeared between the freeze and the reveal (e.g. voided at PayPal) passes the unit on
  for (const pid of lostHold) {
    emit(dropId, "winner_without_hold", `${pid} was drawn but no longer has a live hold, so the unit passes to the waitlist.`, false, { tone: "warn" });
    await promoteNext(dropId);
  }
  settleIfDone(dropId);
  return { winners, waitlist, round: value ? round : null, finalSeed };
}

/** Freeze, then wait for the reveal (tests, scripts). The HTTP endpoint and the sweeper freeze and reveal in the background. */
export async function draw(dropIdOrSlug: string, opts: DrawOptions = {}) {
  const f = await freeze(dropIdOrSlug, opts);
  const r = f.status === "frozen" ? await scheduleReveal(f.dropId) : null;
  return { ...f, status: getDrop(f.dropId)!.status, winners: r?.winners ?? [], waitlist: r?.waitlist ?? [], finalSeed: r?.finalSeed ?? null };
}

function captureAmount(drop: DropRow): number {
  return drop.price_cents + drop.ship_actual_cents; // partial capture: real shipping < shipping held
}

/** The seed the ranking uses: the final seed after a drand reveal, the committed seed for older drops. */
function drawSeed(drop: DropRow): string {
  return drop.final_seed ?? drop.seed;
}

/** Sandbox negative test through PayPal's official negative testing (PayPal-Mock-Response header).
 *  Verified against the real sandbox by scripts/proof-negative-testing.ts: the capture answers 422 TRANSACTION_REFUSED
 *  and the hold stays alive (CREATED), so the app takes the production path: void the live hold, promote the waitlist. */
export const NEGATIVE_TEST_CODE = "TRANSACTION_REFUSED";

function scheduleCapture(drop: DropRow, e: EntryRow, injectFailure: boolean) {
  if (e.source === "simulated" && injectFailure) {
    updateEntry(e.id, { status: "capture_failed", settled_at: now(), note: "Payment failed (negative test on a simulated entrant). The unit passes to the waitlist." });
    emit(drop.id, "capture_failed", `Negative test: the payment of ${e.public_id} (a simulated entrant) fails, so the unit passes to the waitlist.`, false);
    void promoteNext(drop.id);
    return;
  }
  if (e.source === "simulated") {
    updateEntry(e.id, { status: "captured", settled_at: now(), captured_cents: captureAmount(drop), capture_id: `SIM-CAP-${e.id.slice(-6).toUpperCase()}` });
    emit(drop.id, "capture_sim", `Captured ${formatUsd(captureAmount(drop))} from ${e.public_id} (simulated entrant, no PayPal call).`, false);
    settleIfDone(drop.id);
    return;
  }
  enqueue("capture", `cap:${e.authorization_id}:1`, e.id, { injectFailure });
}

function scheduleVoid(drop: DropRow, e: EntryRow, reason: string) {
  if (e.source === "simulated") return releaseSimulated(drop, [e], reason);
  if (!e.authorization_id) return;
  enqueue("void", `void:${e.authorization_id}`, e.id, { reason });
}

/** Simulated holds are released in bulk: one ledger line for the whole group, never one per entrant. */
function releaseSimulated(drop: DropRow, list: EntryRow[], reason: string) {
  if (!list.length) return;
  for (const e of list) updateEntry(e.id, { status: e.status === "merged" ? "merged" : "voided", settled_at: now() });
  emit(
    drop.id,
    "void_sim",
    list.length === 1
      ? `Released the hold of ${list[0].public_id} (${reason}; simulated entrant, no PayPal call). Nobody was charged.`
      : `Released ${list.length} simulated holds (${reason}; no PayPal calls). Nobody was charged.`,
    false,
  );
}

async function promoteNext(dropId: string) {
  const drop = getDrop(dropId)!;
  const ids = JSON.parse(drop.frozen_list ?? "[]") as string[];
  const ranking = (await computeDraw(drawSeed(drop), ids, drop.units, ids.length)).ranking.map((r) => r.publicId);
  const entries = listEntries(dropId);
  const next = ranking.map((pid) => entries.find((e) => e.public_id === pid)!).find((e) => e && e.status === "waitlist");
  if (!next) {
    emit(dropId, "waitlist_empty", "The payment failed and the waitlist is empty, so the unit returns to the maker.", false);
    settleIfDone(dropId);
    return;
  }
  const moved = db
    .prepare("UPDATE entries SET status = 'won', promoted_at = ?, note = ?, updated_at = ? WHERE id = ? AND status = 'waitlist'")
    .run(now(), "Promoted from the waitlist: your hold was already in place.", now(), next.id);
  if (!moved.changes) return promoteNext(dropId);
  emit(dropId, "promoted", `Waitlist #1 ${next.public_id} promoted: their hold already exists, capturing now.`, false);
  scheduleCapture(drop, getEntry(next.id)!, false);
}

function settleIfDone(dropId: string) {
  const entries = listEntries(dropId);
  const drop = getDrop(dropId)!;
  if (drop.status !== "drawn") return;
  const unresolvedWinners = entries.filter((e) => e.status === "won").length;
  if (unresolvedWinners > 0) return;
  // a failed capture whose waitlist promotion is still in flight: not settled yet
  const paid = entries.filter((e) => e.status === "captured").length;
  const failed = entries.filter((e) => e.status === "capture_failed").length;
  const waiting = entries.filter((e) => e.status === "waitlist").length;
  if (failed > 0 && paid < drop.units && waiting > 0) return;
  const released = entries.filter((x) => x.status === "waitlist");
  for (const e of released) updateEntry(e.id, { status: "lost" });
  for (const e of released.filter((x) => x.source !== "simulated")) scheduleVoid(drop, getEntry(e.id)!, "waitlist released after all units were paid");
  releaseSimulated(drop, released.filter((x) => x.source === "simulated").map((e) => getEntry(e.id)!), "waitlist released after all units were paid");
  if (!db.prepare("UPDATE drops SET status = 'settled' WHERE id = ? AND status = 'drawn'").run(dropId).changes) return;
  const cap = entries.filter((e) => e.status === "captured").length;
  emit(dropId, "settled", `Settled: ${plural(cap, "unit")} paid. Every other hold released. Nobody who lost was charged.`, false);
}

// ---------------------------------------------------------------- guarded transitions
// Every money state change is a conditional UPDATE, so the capture op, a webhook and the sweeper can race safely:
// whichever arrives first moves the entry, the others become no-ops (and only write their own ledger line).

/** won → captured (capture op, PAYMENT.CAPTURE.COMPLETED webhook, or the PENDING re-check). */
function markCaptured(e: EntryRow, cents: number, captureId: string | null | undefined): boolean {
  const ch = db
    .prepare(
      `UPDATE entries SET status = 'captured', capture_id = COALESCE(?, capture_id), captured_cents = ?, settled_at = ?,
         note = CASE WHEN note LIKE 'Payment pending%' THEN NULL ELSE note END, updated_at = ?
       WHERE id = ? AND status = 'won'`,
    )
    .run(captureId ?? null, cents, now(), now(), e.id).changes;
  if (!ch && captureId) db.prepare("UPDATE entries SET capture_id = COALESCE(capture_id, ?) WHERE id = ?").run(captureId, e.id);
  if (ch) settleIfDone(e.drop_id);
  return ch > 0;
}

/** won → capture_failed: void the hold if it is still alive (the void op GETs first), then hand the unit on. */
async function markCaptureFailed(e: EntryRow, note: string): Promise<boolean> {
  const ch = db.prepare("UPDATE entries SET status = 'capture_failed', note = ?, settled_at = ?, updated_at = ? WHERE id = ? AND status = 'won'").run(note, now(), now(), e.id).changes;
  if (!ch) return false;
  if (e.authorization_id && e.source !== "simulated") enqueue("void", `void:${e.authorization_id}`, e.id, { reason: "payment failed" });
  await promoteNext(e.drop_id);
  return true;
}

/** captured → refunded (refund op, PAYMENT.CAPTURE.REFUNDED / REVERSED webhook, or reconciliation). */
function markRefunded(e: EntryRow, cents: number, refundId: string | null | undefined): boolean {
  return (
    db
      .prepare("UPDATE entries SET status = 'refunded', refunded_cents = ?, refund_id = COALESCE(?, refund_id), note = ?, updated_at = ? WHERE id = ? AND status = 'captured'")
      .run(cents, refundId ?? null, `Refunded ${formatUsd(cents)}. Nothing is owed.`, now(), e.id).changes > 0
  );
}

// ---------------------------------------------------------------- queue handlers

type OpPayload = { injectFailure?: boolean; reason?: string; authorizationId?: string; carrier?: paypal.CarrierCode; tracking?: string };

const DECLINED_NOTE = "PayPal couldn't use that funding source. Approve again to choose another.";

export const handlers: Handlers = {
  async run(op: OpRow) {
    const e = getEntry(op.entry_id);
    if (!e) return;
    const drop = getDrop(e.drop_id)!;
    const payload = JSON.parse(op.payload) as OpPayload;
    const data = (trace?: Trace) => ({ trace, attempts: op.attempts + 1 });
    if (op.kind === "authorize") {
      // never place a hold for an entry that is no longer waiting for one, or after the drop closed
      if (e.status !== "authorizing") return;
      if (!dropIsOpen(drop)) {
        db.prepare("UPDATE entries SET status = 'expired', note = ?, updated_at = ? WHERE id = ? AND status = 'authorizing'").run(
          "The drop closed before the hold was placed — nothing was charged.",
          now(),
          e.id,
        );
        return;
      }
      const r = await paypal.authorizeOrder(e.order_id!, op.key);
      if (!r.authorizationId) throw new Error(`authorize returned no authorization (status ${r.status})`);
      const placed = db
        .prepare("UPDATE entries SET status = 'held', authorization_id = ?, hold_cents = ?, held_at = ?, note = NULL, updated_at = ? WHERE id = ? AND status = 'authorizing'")
        .run(r.authorizationId, drop.price_cents + drop.ship_hold_cents, now(), now(), e.id);
      if (!placed.changes || !dropIsOpen(getDrop(drop.id)!)) {
        // the drop was drawn while PayPal was authorizing: release this hold immediately
        updateEntry(e.id, { status: "voided", authorization_id: r.authorizationId, note: "The drop closed while the hold was being placed — released." });
        enqueue("void", `void:${r.authorizationId}`, e.id, { reason: "drop closed during authorization", authorizationId: r.authorizationId });
        return;
      }
      emit(drop.id, "hold_placed", `Hold placed for ${e.public_id}: ${formatUsd(drop.price_cents + drop.ship_hold_cents)} authorized (${r.status}). Nothing charged yet.`, true, data(r.trace));
    } else if (op.kind === "capture") {
      if (e.status !== "won") return;
      // Negative test (labelled in the UI): PayPal itself declines this capture; the hold stays alive.
      const mock = payload.injectFailure ? NEGATIVE_TEST_CODE : undefined;
      const r = await paypal.captureAuthorization(e.authorization_id!, captureAmount(drop), op.key, `PAYLET-${e.id.slice(-10)}-1`, { mock });
      if (r.status === "PENDING") {
        updateEntry(e.id, { capture_id: r.captureId ?? null, note: "Payment pending at PayPal — waiting for confirmation." });
        emit(drop.id, "capture_pending", `Capture for ${e.public_id} is PENDING at PayPal: waiting for the PAYMENT.CAPTURE.COMPLETED webhook (re-checked every 2 minutes).`, true, data(r.trace));
        return;
      }
      if (r.status !== "COMPLETED") throw new Error(`CAPTURE_${r.status || "UNKNOWN"}`);
      const cents = fromPayPal(r.amount) || captureAmount(drop);
      emit(
        drop.id,
        "captured",
        `Captured ${formatUsd(cents)} from ${e.public_id} (held ${formatUsd(drop.price_cents + drop.ship_hold_cents)} — ${formatUsd(drop.ship_hold_cents - drop.ship_actual_cents)} of unused shipping released).`,
        true,
        data(r.trace),
      );
      markCaptured(e, cents, r.captureId);
    } else if (op.kind === "void") {
      const authId = e.authorization_id ?? payload.authorizationId;
      if (!authId) return;
      const r = await paypal.voidAuthorizationSafe(authId, op.key);
      if (r.status !== "VOIDED") {
        // PayPal says the hold was captured: never mark it released
        emit(drop.id, "void_skipped", `No void for ${e.public_id}: PayPal reports the hold as ${r.status}.`, true, data(r.trace));
        return;
      }
      db.prepare("UPDATE entries SET status = CASE WHEN status IN ('merged','capture_failed') THEN status ELSE 'voided' END, settled_at = COALESCE(settled_at, ?), updated_at = ? WHERE id = ?").run(
        now(),
        now(),
        e.id,
      );
      emit(drop.id, "voided", `Hold released for ${e.public_id} (${payload.reason ?? "not selected"}) — ${r.already ? "already released" : "voided"}, never charged.`, true, data(r.trace));
    } else if (op.kind === "track") {
      if (!e.capture_id || !e.order_id || !payload.tracking) return;
      const carrier = payload.carrier ?? "USPS";
      const r = await paypal.addTracking(e.order_id, e.capture_id, payload.tracking, carrier);
      updateEntry(e.id, { carrier, tracking_number: payload.tracking, shipped_at: now() });
      emit(
        drop.id,
        "shipped",
        `Shipped ${e.public_id}: ${carrier} tracking …${payload.tracking.slice(-4)} added to the PayPal order${r.already ? " (already on file)" : "; PayPal shows it to the buyer"}.`,
        true,
        data(r.trace),
      );
    } else if (op.kind === "refund") {
      if (e.status !== "captured" || !e.capture_id) return;
      const reason = payload.reason ?? "the item could not be shipped";
      const r = await paypal.refundCapture(e.capture_id, op.key, `Refund from ${drop.maker}: ${reason}.`);
      if (r.status === "COMPLETED") {
        const cents = r.amountCents || e.captured_cents || 0;
        markRefunded(e, cents, r.refundId);
        emit(drop.id, "refunded", `Refunded ${formatUsd(cents)} to ${e.public_id} (${reason}). The buyer owes nothing.`, true, data(r.trace));
      } else if (r.status === "PENDING") {
        updateEntry(e.id, { refund_id: r.refundId ?? null, note: "Refund pending at PayPal." });
        emit(drop.id, "refund_pending", `Refund for ${e.public_id} is PENDING at PayPal: waiting for the PAYMENT.CAPTURE.REFUNDED webhook.`, true, data(r.trace));
      } else {
        throw new Error(`REFUND_${r.status || "UNKNOWN"}`);
      }
    }
  },
  async onTerminal(op, f) {
    const e = getEntry(op.entry_id);
    if (!e) return;
    const payload = JSON.parse(op.payload) as OpPayload;
    const data = { trace: f.trace, attempts: op.attempts + 1 };
    if (op.kind === "authorize") {
      if (f.issue === "INSTRUMENT_DECLINED") {
        // No hold exists. The order's payer-action link stays valid: the person approves again with another funding source.
        const back = db
          .prepare(
            "UPDATE entries SET status = 'awaiting_person', needs_reapproval = 1, payer_hash = NULL, account_hash = NULL, email_hash = NULL, note = ?, updated_at = ? WHERE id = ? AND status = 'authorizing'",
          )
          .run(DECLINED_NOTE, now(), e.id);
        if (back.changes) emit(e.drop_id, "authorize_declined", `PayPal declined the funding source for ${e.public_id} (${f.status} INSTRUMENT_DECLINED): no hold placed. The person can approve again with another one.`, true, data);
        return;
      }
      updateEntry(e.id, { status: "error", note: `PayPal could not place the hold (${f.issue}).` });
      emit(e.drop_id, "authorize_failed", `Hold failed for ${e.public_id}: ${f.status} ${f.issue}.`, true, data);
    } else if (op.kind === "capture") {
      if (f.cls === "CONFIG") {
        // our credentials/permissions are broken: do NOT burn through the waitlist — retry later
        db.prepare("UPDATE ops SET status = 'pending', attempts = 0, next_at = ? WHERE key = ?").run(now() + 10 * 60_000, op.key);
        emit(e.drop_id, "capture_blocked", `Capture for ${e.public_id} blocked by a configuration error (${f.status} ${f.issue}); retrying in 10 minutes.`, true, data);
        return;
      }
      // reconcile with PayPal before declaring the payment failed
      let holdStatus = "";
      try {
        const a = await paypal.getAuthorization(e.authorization_id!);
        holdStatus = a.status;
        if (a.status === "CAPTURED" || a.status === "PARTIALLY_CAPTURED") {
          emit(e.drop_id, "captured", `Capture for ${e.public_id} confirmed by reconciliation with PayPal (${a.status}).`, true, { trace: a.trace });
          markCaptured(e, captureAmount(getDrop(e.drop_id)!), null);
          return;
        }
      } catch {
        /* reconciliation is best-effort; the void op GETs again before voiding */
      }
      const alive = holdStatus === "CREATED" || holdStatus === "PENDING" ? ` PayPal still shows the hold as ${holdStatus}: voiding it` : " Voiding the hold";
      if (payload.injectFailure) {
        emit(e.drop_id, "negative_test", `PayPal sandbox negative test (PayPal-Mock-Response: ${NEGATIVE_TEST_CODE}) → ${f.status} ${f.issue} for ${e.public_id}.${alive} and passing the unit to the waitlist.`, true, data);
      } else {
        emit(e.drop_id, "capture_failed", `Capture failed for ${e.public_id}: PayPal ${f.status} ${f.issue}.${alive} and promoting the waitlist.`, true, data);
      }
      await markCaptureFailed(e, payload.injectFailure ? `Payment failed (PayPal sandbox negative test: ${f.issue}). The unit passes to the waitlist.` : `Payment failed (${f.issue}). The unit passes to the waitlist.`);
    } else if (op.kind === "track") {
      emit(e.drop_id, "track_failed", `PayPal did not accept the tracking for ${e.public_id}: ${f.status} ${f.issue}. The seller can try again.`, true, data);
    } else if (op.kind === "refund") {
      // refunded elsewhere (e.g. from the PayPal dashboard)? reconcile before reporting a failure
      try {
        if (e.capture_id) {
          const c = await paypal.getCapture(e.capture_id);
          if (c.status === "REFUNDED" && markRefunded(e, e.captured_cents ?? 0, null)) {
            emit(e.drop_id, "refunded", `Refund for ${e.public_id} confirmed by PayPal (capture REFUNDED).`, true, { trace: c.trace });
            return;
          }
        }
      } catch {
        /* best-effort */
      }
      emit(e.drop_id, "refund_failed", `Refund for ${e.public_id} failed: ${f.status} ${f.issue}. The payment stays captured.`, true, data);
    } else {
      emit(e.drop_id, "void_failed", `Void failed for ${e.public_id}: ${f.status} ${f.issue} (the sweeper will retry).`, true, data);
    }
  },
};

// ---------------------------------------------------------------- webhooks (routed after signature verification + de-duplication)

export interface WebhookEvent {
  id?: string;
  event_type?: string;
  resource?: Record<string, unknown>;
}

/** Every PayPal id a webhook resource points at: its own id, related ids, `links` (refund → capture) and disputes. */
function webhookIds(r: Record<string, unknown> | undefined): string[] {
  if (!r) return [];
  const ids = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && /^[A-Za-z0-9-]{6,64}$/.test(v)) ids.add(v);
  };
  add(r.id);
  const rel = ((r.supplementary_data as { related_ids?: Record<string, unknown> } | undefined)?.related_ids ?? {}) as Record<string, unknown>;
  add(rel.order_id);
  add(rel.authorization_id);
  add(rel.capture_id);
  for (const l of Array.isArray(r.links) ? (r.links as { href?: unknown }[]) : []) {
    const m = typeof l?.href === "string" ? l.href.match(/\/v2\/(?:payments\/(?:captures|authorizations|refunds)|checkout\/orders)\/([A-Za-z0-9-]+)/) : null;
    if (m) add(m[1]);
  }
  for (const t of Array.isArray(r.disputed_transactions) ? (r.disputed_transactions as { seller_transaction_id?: unknown }[]) : []) add(t?.seller_transaction_id);
  return [...ids].slice(0, 12);
}

export function entryForWebhook(evt: WebhookEvent): EntryRow | undefined {
  const ids = webhookIds(evt.resource);
  if (!ids.length) return undefined;
  const q = ids.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM entries WHERE source <> 'simulated' AND (order_id IN (${q}) OR authorization_id IN (${q}) OR capture_id IN (${q}) OR refund_id IN (${q})) LIMIT 1`)
    .get(...ids, ...ids, ...ids, ...ids) as EntryRow | undefined;
}

const FINALIZE_WORDS: Record<FinalizeOutcome, string> = {
  authorizing: "approved, placing the hold",
  duplicate: "same PayPal account as an existing entry, no hold placed",
  not_approved: "not approved yet",
  closed: "approved after the drop closed, no hold placed",
  already: "already handled",
  unknown_order: "unknown order",
};

/** P1-05: verified webhooks change state. Every transition is guarded by the entry's current status. */
export async function routeWebhook(evt: WebhookEvent): Promise<{ entry?: EntryRow; outcome: string }> {
  const type = evt.event_type ?? "";
  const r = evt.resource ?? {};
  const rid = typeof r.id === "string" ? r.id : null;
  const amountCents = fromPayPal((r.amount as { value?: string } | undefined)?.value);
  if (type === "CHECKOUT.ORDER.APPROVED") {
    if (!rid) return { outcome: "ignored" };
    const out = await finalize(rid);
    return { entry: out.entry, outcome: FINALIZE_WORDS[out.outcome] };
  }
  const e = entryForWebhook(evt);
  if (!e) return { outcome: "no matching entry" };
  const drop = getDrop(e.drop_id)!;
  switch (type) {
    case "PAYMENT.CAPTURE.COMPLETED":
      if (markCaptured(e, amountCents || captureAmount(drop), rid)) return { entry: e, outcome: "captured" };
      return { entry: e, outcome: e.status === "captured" || e.status === "refunded" ? "capture confirmed" : `no change (${e.status})` };
    case "PAYMENT.CAPTURE.PENDING":
      if (e.status === "won" && !e.capture_id && rid) updateEntry(e.id, { capture_id: rid, note: "Payment pending at PayPal — waiting for confirmation." });
      return { entry: e, outcome: "capture pending at PayPal" };
    case "PAYMENT.CAPTURE.DENIED":
      if (rid && !e.capture_id) db.prepare("UPDATE entries SET capture_id = ? WHERE id = ? AND capture_id IS NULL").run(rid, e.id);
      if (await markCaptureFailed(e, "Payment denied by PayPal. The unit passes to the waitlist.")) return { entry: e, outcome: "payment denied, hold voided, waitlist promoted" };
      return { entry: e, outcome: `no change (${e.status})` };
    case "PAYMENT.CAPTURE.REFUNDED":
    case "PAYMENT.CAPTURE.REVERSED": {
      if (e.status === "refunded") return { entry: e, outcome: "refund confirmed" };
      if (e.status !== "captured") return { entry: e, outcome: `no change (${e.status})` };
      if (amountCents && e.captured_cents && amountCents < e.captured_cents) {
        updateEntry(e.id, { refunded_cents: amountCents, refund_id: rid, note: `Partially refunded (${formatUsd(amountCents)}).` });
        return { entry: e, outcome: `partially refunded ${formatUsd(amountCents)}` };
      }
      markRefunded(e, amountCents || e.captured_cents || 0, rid);
      return { entry: e, outcome: type === "PAYMENT.CAPTURE.REVERSED" ? "payment reversed, marked refunded" : "refunded" };
    }
    case "PAYMENT.AUTHORIZATION.VOIDED": {
      // merged / capture_failed keep their status (they explain why); anything still counting on the hold loses it
      const ch = db
        .prepare("UPDATE entries SET status = 'voided', settled_at = COALESCE(settled_at, ?), updated_at = ? WHERE id = ? AND status IN ('held','lost','waitlist')")
        .run(now(), now(), e.id).changes;
      return { entry: e, outcome: ch ? "hold voided" : e.status === "voided" ? "void confirmed" : `hold voided (entry stays ${e.status})` };
    }
    case "PAYMENT.AUTHORIZATION.CREATED":
      return { entry: e, outcome: "hold confirmed" };
    case "CUSTOMER.DISPUTE.CREATED":
      return { entry: e, outcome: "dispute opened; the seller answers it in PayPal" };
    default:
      return { entry: e, outcome: "logged" };
  }
}

// ---------------------------------------------------------------- sweeper

/** GETs are the source of truth: reconcile approvals that never reached /finalize (agent tabs closed, webhooks late). */
export async function sweep(): Promise<void> {
  const stale = db
    .prepare(
      "SELECT * FROM entries WHERE status = 'awaiting_person' AND needs_reapproval IS NULL AND order_id IS NOT NULL AND created_at < ? AND created_at > ? AND updated_at < ? ORDER BY updated_at LIMIT 3",
    )
    // each pending order is re-checked at most every 2 minutes, for 45 minutes (keeps us far below sandbox rate limits)
    .all(now() - 20_000, now() - 45 * 60_000, now() - 120_000) as unknown as EntryRow[];
  for (const e of stale) {
    try {
      db.prepare("UPDATE entries SET updated_at = ? WHERE id = ?").run(now(), e.id);
      await finalize(e.order_id!, { quiet: true });
    } catch (err) {
      console.warn("sweep", e.id, paypal.classify(err).issue);
    }
  }
  await reconcilePendingCaptures();
  // Any real hold still "held" in a drop that has been drawn is outside the ballot: release it.
  // (While a drop is 'frozen' its held entries ARE the ballot: they wait for the reveal.)
  const strays = db
    .prepare("SELECT e.* FROM entries e JOIN drops d ON d.id = e.drop_id WHERE e.status = 'held' AND e.source <> 'simulated' AND d.status IN ('drawn','settled') LIMIT 5")
    .all() as unknown as EntryRow[];
  for (const e of strays) {
    updateEntry(e.id, { status: "lost", note: "Hold placed outside the ballot — released." });
    scheduleVoid(getDrop(e.drop_id)!, getEntry(e.id)!, "outside the ballot");
  }
  // Re-arm voids that failed terminally (voidAuthorizationSafe GETs first, so this is idempotent).
  db.prepare(
    "UPDATE ops SET status = 'pending', attempts = 0, next_at = ? WHERE key IN (SELECT key FROM ops WHERE kind = 'void' AND status = 'failed' AND updated_at < ? AND created_at > ? ORDER BY updated_at LIMIT 3)",
  ).run(now(), now() - 10 * 60_000, now() - 28 * 86_400_000);
  // Frozen drops waiting for public randomness (a restart, or drand was down): reveal them.
  const frozen = db.prepare("SELECT id FROM drops WHERE status = 'frozen'").all() as { id: string }[];
  for (const d of frozen) if (!reveals.has(d.id) && (revealRetryAt.get(d.id) ?? 0) <= now()) void scheduleReveal(d.id);
  // Draw open drops past their close time (judge drops close after 30 min). Proof drops are never drawn automatically.
  // Pending AI suggestions give the seller REVIEW_GRACE_MS more to decide; after that the draw says they were not reviewed.
  const expired = db.prepare("SELECT id, closes_at FROM drops WHERE status = 'open' AND closes_at < ? AND kind <> 'proof'").all(now()) as { id: string; closes_at: number }[];
  for (const d of expired) {
    if (pendingReviews(d.id).suggestions && d.closes_at > now() - REVIEW_GRACE_MS) continue;
    try {
      const f = await freeze(d.id, { auto: true });
      if (f.status === "frozen") void scheduleReveal(f.dropId);
    } catch (err) {
      console.warn("auto-draw", d.id, String(err));
    }
  }
}

/** P1-05: a capture PayPal answered PENDING leaves its winner in `won`. If no webhook settles it within 2 minutes,
 *  ask PayPal (GET /v2/payments/captures/{id}) every 2 minutes: COMPLETED → captured, DECLINED/FAILED → waitlist. */
export async function reconcilePendingCaptures(): Promise<void> {
  const pending = db
    .prepare("SELECT * FROM entries WHERE status = 'won' AND capture_id IS NOT NULL AND source <> 'simulated' AND updated_at < ? ORDER BY updated_at LIMIT 3")
    .all(now() - 120_000) as unknown as EntryRow[];
  for (const e of pending) {
    try {
      db.prepare("UPDATE entries SET updated_at = ? WHERE id = ?").run(now(), e.id);
      const c = await paypal.getCapture(e.capture_id!);
      if (c.status === "COMPLETED") {
        emit(e.drop_id, "captured", `Re-checked with PayPal: the pending capture for ${e.public_id} is COMPLETED (${formatUsd(c.amountCents)}).`, true, { trace: c.trace });
        markCaptured(e, c.amountCents || captureAmount(getDrop(e.drop_id)!), e.capture_id);
      } else if (c.status === "DECLINED" || c.status === "FAILED") {
        emit(e.drop_id, "capture_failed", `Re-checked with PayPal: the pending capture for ${e.public_id} is ${c.status}. Voiding the hold and promoting the waitlist.`, true, { trace: c.trace });
        await markCaptureFailed(e, `Payment ${c.status.toLowerCase()} at PayPal. The unit passes to the waitlist.`);
      }
    } catch (err) {
      console.warn("sweep capture", e.id, paypal.classify(err).issue);
    }
  }
}

// ---------------------------------------------------------------- after the sale: tracking and refunds (P2-01)

export const CARRIER_CODES = ["USPS", "UPS", "FEDEX", "OTHER"] as const;

function entryOfDrop(dropId: string, entryId: string): EntryRow {
  const e = getEntry(entryId);
  if (!e || e.drop_id !== dropId) throw new HttpError(404, "entry_not_found");
  return e;
}

/** A USPS-style demo tracking number (22 digits) for the "Mark shipped" prefill. */
export function demoTrackingNumber(): string {
  return `9400100000${String(Date.now()).slice(-8)}${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}`;
}

/** Seller marks a captured entry shipped: the tracking number is added to the PayPal order (async, via the queue). */
export function shipEntry(dropId: string, entryId: string, input: { carrier?: unknown; tracking?: unknown }) {
  const e = entryOfDrop(dropId, entryId);
  const carrier = String(input.carrier ?? "USPS").toUpperCase() as (typeof CARRIER_CODES)[number];
  if (!CARRIER_CODES.includes(carrier)) throw new HttpError(400, "bad_carrier", "Carrier must be USPS, UPS, FEDEX or OTHER.");
  const tracking = (typeof input.tracking === "string" && input.tracking.trim() ? input.tracking : demoTrackingNumber()).replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z0-9]{6,40}$/.test(tracking)) throw new HttpError(400, "bad_tracking", "A tracking number is 6 to 40 letters or digits.");
  if (e.status !== "captured") throw new HttpError(409, "not_captured", "Only a paid (captured) entry can be marked shipped.");
  if (e.tracking_number) {
    if (e.tracking_number === tracking) return;
    throw new HttpError(409, "already_shipped", "This entry already has a tracking number.");
  }
  if (pendingOpsFor(e.id).includes("track")) return;
  const drop = getDrop(dropId)!;
  if (e.source === "simulated") {
    updateEntry(e.id, { carrier, tracking_number: tracking, shipped_at: now() });
    emit(drop.id, "shipped_sim", `${e.public_id} marked shipped: ${carrier} …${tracking.slice(-4)} (simulated entrant, no PayPal call).`, false);
    return;
  }
  if (!e.capture_id || !e.order_id) throw new HttpError(409, "not_captured", "Only a paid (captured) entry can be marked shipped.");
  const n = opCount(e.id, "track");
  enqueue("track", n ? `track:${e.capture_id}:${n + 1}` : `track:${e.capture_id}`, e.id, { carrier, tracking });
}

/** Seller refunds a captured entry in full (async, via the queue; PayPal-Request-Id = refund:<captureId>). */
export function refundEntry(dropId: string, entryId: string, reason?: unknown) {
  const e = entryOfDrop(dropId, entryId);
  if (e.status === "refunded") return;
  if (e.status !== "captured") throw new HttpError(409, "not_captured", "Only a paid (captured) entry can be refunded.");
  // the reason is public (ledger) and goes to the buyer: plain words only
  const why =
    (typeof reason === "string" ? reason : "")
      .replace(/[^\p{L}\p{N} .,:;&'!?()-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "the maker could not ship";
  const drop = getDrop(dropId)!;
  if (e.source === "simulated") {
    const cents = e.captured_cents ?? 0;
    markRefunded(e, cents, null);
    emit(drop.id, "refund_sim", `Refunded ${formatUsd(cents)} to ${e.public_id} (${why}; simulated entrant, no PayPal call).`, false);
    return;
  }
  if (!e.capture_id) throw new HttpError(409, "not_captured", "Only a paid (captured) entry can be refunded.");
  if (pendingOpsFor(e.id).includes("refund")) return;
  const n = opCount(e.id, "refund");
  enqueue("refund", n ? `refund:${e.capture_id}:${n + 1}` : `refund:${e.capture_id}`, e.id, { reason: why });
}

// ---------------------------------------------------------------- participant & appeals

export function participantView(entryId: string) {
  const e = getEntry(entryId);
  if (!e) throw new HttpError(404, "entry_not_found");
  const d = getDrop(e.drop_id)!;
  return {
    entryId: e.id,
    publicId: e.public_id,
    source: e.source,
    agentLabel: e.agent_label,
    status: e.status,
    holdCents: e.hold_cents,
    capturedCents: e.captured_cents,
    refundedCents: e.refunded_cents,
    note: e.note,
    explanation: e.explanation,
    // only while the person still has to approve (lets /me resume the approval)
    approveUrl: e.status === "awaiting_person" ? e.approve_url : null,
    payerVerified: e.payer_verified == null ? null : e.payer_verified === 1,
    shipping: e.tracking_number ? { carrier: e.carrier ?? "OTHER", tracking: e.tracking_number } : null,
    timeline: { requestedAt: e.created_at, approvedAt: e.approved_at, heldAt: e.held_at, drawAt: d.drawn_at, settledAt: e.settled_at },
    drop: { slug: d.slug, title: d.title, maker: d.maker, status: d.status, closesAt: d.closes_at, units: d.units, art: d.art },
  };
}

/** GET /api/drops/:slug/verify: everything a browser needs to re-run the draw, plus the recorded outcome of EVERY
 *  frozen entry and every exclusion with its reason (so "who was left out, and why" is public too). */
export function verifyData(d: DropRow) {
  const entries = listEntries(d.id);
  const byPid = new Map(entries.map((e) => [e.public_id, e]));
  const frozenList = d.status === "open" ? null : (JSON.parse(d.frozen_list ?? "[]") as string[]);
  const excluded = d.status === "open"
    ? []
    : d.excluded_json
      ? (JSON.parse(d.excluded_json) as { publicId: string; reason: "merged" | "duplicate" }[])
      : entries.filter((e) => e.status === "merged" || e.status === "duplicate").map((e) => ({ publicId: e.public_id, reason: e.status as "merged" | "duplicate" }));
  return {
    title: d.title,
    status: d.status,
    units: d.units,
    waitlistSize: d.waitlist_size,
    closesAt: d.closes_at,
    seedHash: d.seed_hash,
    seed: revealed(d) ? d.seed : null,
    frozenHash: d.status === "open" ? null : d.frozen_hash,
    frozenList,
    randomness: randomnessOf(d),
    finalSeed: revealed(d) ? d.final_seed : null,
    excluded,
    outcome: (frozenList ?? []).map((pid) => {
      const e = byPid.get(pid);
      const note = e?.note && e.source !== "simulated" ? e.note : e?.status === "capture_failed" || e?.promoted_at ? (e?.note ?? undefined) : undefined;
      return { publicId: pid, status: e?.status ?? "unknown", ...(note ? { note } : {}) };
    }),
  };
}

export function fileAppeal(entryId: string, message: string) {
  const e = getEntry(entryId);
  if (!e) throw new HttpError(404, "entry_not_found");
  db.prepare("INSERT INTO appeals(id, drop_id, entry_id, message, status, created_at) VALUES(?, ?, ?, ?, 'open', ?)").run(id("apl", 6), e.drop_id, e.id, message.slice(0, 600), now());
  if (e.cluster_id) db.prepare("UPDATE clusters SET status = 'suggested' WHERE id = ? AND status = 'confirmed'").run(e.cluster_id);
  emit(e.drop_id, "appeal", `Appeal filed by ${e.public_id}: "${message.slice(0, 80)}" — cluster returned to the seller for review.`, false);
}
