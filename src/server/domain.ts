import { randomBytes } from "node:crypto";
import { db, now, tx } from "./db";
import { env } from "./env";
import { canonicalList, computeDraw, sha256Hex } from "../shared/draw";
import { formatUsd } from "../shared/money";
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
import { enqueue, type Handlers, type OpRow } from "./queue";
import { resolve } from "./er/resolve";
import type { Identity } from "./er/normalize";
import { syntheticCrowd } from "./simulate";

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
  kind: "showcase" | "judge";
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

export function publicDrop(d: DropRow) {
  const entries = listEntries(d.id);
  const count = (s: (e: EntryRow) => boolean) => entries.filter(s).length;
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
    seed: d.status === "open" ? null : d.seed,
    frozenHash: d.frozen_hash,
    frozenList: d.status === "open" ? null : d.frozen_list ? (JSON.parse(d.frozen_list) as string[]) : null,
    waitlistSize: d.waitlist_size,
    stats: {
      requests: count((e) => e.source !== "simulated"),
      awaitingPerson: count((e) => e.status === "awaiting_person"),
      holds: count((e) => e.source !== "simulated" && e.hold_cents != null && e.status !== "duplicate"),
      duplicatesBlocked: count((e) => e.status === "duplicate"),
      merged: count((e) => e.status === "merged"),
      simulated: count((e) => e.source === "simulated"),
      agents: count((e) => e.source === "agent"),
      captured: count((e) => e.source !== "simulated" && e.status === "captured"),
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
  const { orderId, approveUrl } = await paypal.createHoldOrder({
    dropId: drop.id,
    entryId,
    title: drop.title,
    sku: drop.slug.slice(0, 120),
    priceCents: drop.price_cents,
    shipHoldCents: drop.ship_hold_cents,
    returnUrl: `${base}/return?entry=${entryId}`,
    cancelUrl: `${base}/return?entry=${entryId}&cancelled=1`,
  });
  updateEntry(entryId, { order_id: orderId });
  emit(
    drop.id,
    "order_created",
    source === "agent"
      ? `Agent "${agentLabel ?? "unnamed"}" requested entry ${pid} → PayPal approval link issued; agent stops here (it cannot pay).`
      : `Fan opened PayPal for entry ${pid} (hold of ${formatUsd(drop.price_cents + drop.ship_hold_cents)} requested).`,
    true,
    { orderId },
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

  const ident = await paypal.getOrderIdentity(orderId);
  // re-read after the await: the drop may have been drawn meanwhile
  const drop = getDrop(entry.drop_id)!;
  if (!opts.quiet || ident.status === "APPROVED") emit(drop.id, "order_checked", `GET order for ${entry.public_id}: ${ident.status}`, true);
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
          `UPDATE entries SET payer_hash = ?, account_hash = ?, email_hash = ?, name = ?, display_name = ?, email = ?, address_json = ?, status = 'authorizing', updated_at = ?
           WHERE id = ? AND status = 'awaiting_person' AND EXISTS (SELECT 1 FROM drops WHERE id = ? AND status = 'open' AND closes_at > ?)`,
        )
        .run(...fields, now(), entry.id, drop.id, now()).changes,
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
  enqueue("authorize", `auth:${entry.id}`, entry.id);
  return { outcome: "authorizing", entry: getEntry(entry.id) };
}

// ---------------------------------------------------------------- simulated crowd

export function addSimulatedCrowd(dropIdOrSlug: string, seed = Math.floor(Math.random() * 1e6)) {
  const drop = getDrop(dropIdOrSlug);
  if (!drop) throw new HttpError(404, "drop_not_found");
  if (!dropIsOpen(drop)) throw new HttpError(409, "drop_closed");
  const sims = (db.prepare("SELECT COUNT(*) n FROM entries WHERE drop_id = ? AND source = 'simulated'").get(drop.id) as { n: number }).n;
  if (sims >= 60) throw new HttpError(409, "sim_limit", "This drop already has its simulated crowd.");
  const crowd = syntheticCrowd(seed, { fans: 12, networks: 1, netSize: 6, households: 1, neighbors: 1, namesakes: 1 }, `sim${seed}`);
  const t = now();
  for (const [i, p] of crowd.entries()) {
    const entryId = id("ent", 8);
    db.prepare(
      `INSERT INTO entries(id, public_id, drop_id, source, agent_label, status, payer_hash, name, display_name, email, address_json, hold_cents, authorization_id, created_at, updated_at, note)
       VALUES(?, ?, ?, 'simulated', ?, 'held', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SIMULATED entrant — no PayPal call')`,
    ).run(
      entryId,
      publicId(),
      drop.id,
      p.kind === "reshipper_network" ? "scalper-bot" : null,
      hmac(`sim:${p.id}`),
      p.name,
      `${p.name.split(" ")[0]} ${(p.name.split(" ")[1] ?? "").slice(0, 1)}.`,
      p.email ?? null,
      JSON.stringify(p.address),
      drop.price_cents + drop.ship_hold_cents,
      `SIM-${entryId.slice(-8).toUpperCase()}`,
      t - (crowd.length - i) * 7000,
      t,
    );
  }
  emit(drop.id, "simulated_crowd", `Added ${crowd.length} SIMULATED entrants (labelled; no PayPal calls) to show allocation at scale.`, false);
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
    source: e.source === "simulated" && e.agent_label ? "agent" : e.source,
    agentLabel: e.agent_label,
  };
}

const analyzing = new Set<string>();

export async function analyzeDrop(dropIdOrSlug: string) {
  const drop = getDrop(dropIdOrSlug);
  if (!drop) throw new HttpError(404, "drop_not_found");
  if (analyzing.has(drop.id)) throw new HttpError(409, "analysis_running", "An AI review is already running for this drop.");
  const entries = listEntries(drop.id).filter((e) => e.status === "held" || e.status === "authorizing");
  if (entries.length > 300) throw new HttpError(413, "too_many_entries");
  const identities = entries.map(identityOf).filter((x): x is Identity => !!x);
  const t0 = Date.now();
  analyzing.add(drop.id);
  let result;
  try {
    result = await resolve(identities, { useLlm: true });
  } finally {
    analyzing.delete(drop.id);
  }
  const ms = Date.now() - t0;
  tx(() => {
    // replace previous suggestions (keep seller decisions)
    db.prepare("DELETE FROM clusters WHERE drop_id = ? AND status = 'suggested'").run(drop.id);
    const decided = db.prepare("SELECT member_ids FROM clusters WHERE drop_id = ? AND status <> 'suggested'").all(drop.id) as { member_ids: string }[];
    const decidedKeys = new Set(decided.map((d) => JSON.parse(d.member_ids).sort().join(",")));
    for (const c of result.clusters) {
      if (decidedKeys.has([...c.memberIds].sort().join(","))) continue;
      db.prepare(
        `INSERT INTO clusters(id, drop_id, kind, status, method, confidence, evidence_json, explanation, member_ids, created_at) VALUES(?, ?, ?, 'suggested', ?, ?, ?, ?, ?, ?)`,
      ).run(id("clu", 6), drop.id, c.kind, c.method, c.confidence, JSON.stringify(c.evidence), c.explanation, JSON.stringify(c.memberIds), now());
    }
  });
  emit(
    drop.id,
    "er_done",
    `Entity resolution: ${identities.length} entries, ${result.uncertainPairs} fuzzy pairs sent to the AI (${result.llmCalls} call${result.llmCalls === 1 ? "" : "s"}), ${result.clusters.length} cluster(s) suggested in ${(ms / 1000).toFixed(1)}s.${result.aiDegraded ? ` AI unavailable (${result.aiDegraded}) — rules-only suggestions.` : ""} Seller must confirm.`,
    false,
  );
  return { ...result, ms };
}

export function decideCluster(dropId: string, clusterId: string, decision: "confirmed" | "dismissed") {
  const c = db.prepare("SELECT * FROM clusters WHERE id = ? AND drop_id = ?").get(clusterId, dropId) as ClusterRow | undefined;
  if (!c) throw new HttpError(404, "cluster_not_found");
  const d = getDrop(dropId)!;
  if (d.status !== "open") throw new HttpError(409, "drop_closed");
  db.prepare("UPDATE clusters SET status = ? WHERE id = ? AND drop_id = ?").run(decision, clusterId, dropId);
  const ids = JSON.parse(c.member_ids) as string[];
  emit(c.drop_id, "cluster_" + decision, `Seller ${decision} a ${c.kind} cluster of ${ids.length} PayPal accounts.`, false);
}

export function listClusters(dropId: string) {
  return (db.prepare("SELECT * FROM clusters WHERE drop_id = ? ORDER BY confidence DESC").all(dropId) as unknown as ClusterRow[]).map((c) => ({
    ...c,
    evidence: JSON.parse(c.evidence_json),
    memberIds: JSON.parse(c.member_ids) as string[],
  }));
}

// ---------------------------------------------------------------- draw & settlement

export async function draw(dropIdOrSlug: string) {
  const drop = getDrop(dropIdOrSlug);
  if (!drop) throw new HttpError(404, "drop_not_found");
  if (drop.status !== "open") throw new HttpError(409, "already_drawn");
  const pendingAuth = listEntries(drop.id).filter((e) => e.status === "authorizing").length;
  if (pendingAuth) throw new HttpError(409, "holds_pending", `${pendingAuth} hold(s) still being placed — try again in a few seconds`);

  // Close the drop atomically BEFORE any await, so no finalize() can slip a new hold in afterwards.
  const closed = db.prepare("UPDATE drops SET status = 'drawn', drawn_at = ? WHERE id = ? AND status = 'open'").run(now(), drop.id);
  if (!closed.changes) throw new HttpError(409, "already_drawn");
  const entries = listEntries(drop.id);
  const held = entries.filter((e) => e.status === "held");
  // Confirmed clusters: one allocation per cluster (earliest entry keeps its place).
  const confirmed = (db.prepare("SELECT * FROM clusters WHERE drop_id = ? AND status = 'confirmed'").all(drop.id) as unknown as ClusterRow[]).map((c) => ({
    ...c,
    ids: JSON.parse(c.member_ids) as string[],
  }));
  const mergedIds = new Set<string>();
  for (const c of confirmed) {
    const members = held.filter((e) => c.ids.includes(e.id)).sort((a, b) => a.created_at - b.created_at);
    for (const m of members.slice(1)) {
      mergedIds.add(m.id);
      updateEntry(m.id, {
        status: "merged",
        cluster_id: c.id,
        // templated on purpose: the fan never sees free-form model text or other people's details
        explanation: `The seller confirmed that this PayPal account belongs to the same ${c.kind === "operator" ? "shipping operation" : "household"} as ${members.length - 1} other entr${members.length - 1 === 1 ? "y" : "ies"} (shared delivery address). One allocation per ${c.kind === "operator" ? "operation" : "household"} — your hold is released, nothing was charged.`,
      });
    }
    if (members[0]) updateEntry(members[0].id, { cluster_id: c.id });
  }
  const eligible = held.filter((e) => !mergedIds.has(e.id));
  const ids = eligible.map((e) => e.public_id);
  const frozenHash = await sha256Hex(canonicalList(ids));
  const result = await computeDraw(drop.seed, ids, drop.units, drop.waitlist_size);
  const byPid = new Map(eligible.map((e) => [e.public_id, e]));

  db.prepare("UPDATE drops SET frozen_hash = ?, frozen_list = ? WHERE id = ?").run(frozenHash, JSON.stringify([...ids].sort()), drop.id);
  emit(drop.id, "draw", `Draw: list of ${ids.length} eligible entries frozen (hash ${frozenHash.slice(0, 12)}…), seed revealed. ${result.winners.length} winner(s), ${result.waitlist.length} on waitlist.`, false, {
    frozenHash,
    seed: drop.seed,
  });

  // 1) assign every status first (so settlement bookkeeping never sees a half-drawn drop) …
  for (const pid of result.winners) updateEntry(byPid.get(pid)!.id, { status: "won" });
  for (const pid of result.waitlist) updateEntry(byPid.get(pid)!.id, { status: "waitlist" });
  const losers = eligible.filter((e) => !result.winners.includes(e.public_id) && !result.waitlist.includes(e.public_id));
  for (const e of losers) updateEntry(e.id, { status: "lost" });
  // 2) … then move money.
  // Sandbox negative test: one winner's payment fails so the waitlist hand-off is visible. Prefer a SIMULATED winner
  // (so a real person's hold is captured normally); only if every winner is real does a real hold get the PayPal 422.
  const failPid = drop.negative_test === 1 ? (result.winners.find((p) => byPid.get(p)!.source === "simulated") ?? result.winners[0]) : null;
  for (const pid of result.winners) scheduleCapture(drop, getEntry(byPid.get(pid)!.id)!, pid === failPid);
  for (const e of losers) scheduleVoid(drop, getEntry(e.id)!, "not selected");
  for (const idm of mergedIds) scheduleVoid(drop, getEntry(idm)!, "merged into a confirmed cluster");
  // Pending approvals that never completed simply expire (no hold exists).
  for (const e of entries.filter((x) => x.status === "awaiting_person")) updateEntry(e.id, { status: "expired", note: "not approved before the draw" });
  return { ...result, frozenHash };
}

function captureAmount(drop: DropRow): number {
  return drop.price_cents + drop.ship_actual_cents; // partial capture: real shipping < shipping held
}

function scheduleCapture(drop: DropRow, e: EntryRow, injectFailure: boolean) {
  if (e.source === "simulated" && injectFailure) {
    updateEntry(e.id, { status: "capture_failed", note: "Payment failed (SIMULATED negative test). The unit passes to the waitlist." });
    emit(drop.id, "capture_failed", `SIMULATED negative test: capture for ${e.public_id} declined — promoting the waitlist.`, false);
    void promoteNext(drop.id);
    return;
  }
  if (e.source === "simulated") {
    updateEntry(e.id, { status: "captured", captured_cents: captureAmount(drop), capture_id: `SIM-CAP-${e.id.slice(-6).toUpperCase()}` });
    emit(drop.id, "capture_sim", `SIMULATED capture for ${e.public_id} (${formatUsd(captureAmount(drop))}).`, false);
    settleIfDone(drop.id);
    return;
  }
  enqueue("capture", `cap:${e.authorization_id}:1`, e.id, { injectFailure });
}

function scheduleVoid(drop: DropRow, e: EntryRow, reason: string) {
  if (e.source === "simulated") {
    updateEntry(e.id, { status: e.status === "merged" ? "merged" : "voided" });
    emit(drop.id, "void_sim", `SIMULATED hold release for ${e.public_id} (${reason}).`, false);
    return;
  }
  if (!e.authorization_id) return;
  enqueue("void", `void:${e.authorization_id}`, e.id, { reason });
}

async function promoteNext(dropId: string) {
  const drop = getDrop(dropId)!;
  const ids = (JSON.parse(drop.frozen_list ?? "[]") as string[]);
  const ranking = (await computeDraw(drop.seed, ids, drop.units, ids.length)).ranking.map((r) => r.publicId);
  const entries = listEntries(dropId);
  const next = ranking.map((pid) => entries.find((e) => e.public_id === pid)!).find((e) => e && e.status === "waitlist");
  if (!next) {
    emit(dropId, "waitlist_empty", "Capture failed and the waitlist is empty — unit returns to the maker.", false);
    settleIfDone(dropId);
    return;
  }
  updateEntry(next.id, { status: "won", note: "Promoted from the waitlist — your hold was already in place." });
  emit(dropId, "promoted", `Waitlist #1 ${next.public_id} promoted — their hold already exists, capturing now.`, false);
  scheduleCapture(drop, next, false);
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
  for (const e of entries.filter((x) => x.status === "waitlist")) {
    updateEntry(e.id, { status: "lost" });
    scheduleVoid(drop, e, "waitlist released after all units were paid");
  }
  db.prepare("UPDATE drops SET status = 'settled' WHERE id = ?").run(dropId);
  const cap = entries.filter((e) => e.status === "captured").length;
  emit(dropId, "settled", `Settled: ${cap} unit(s) paid. Every other hold released. Nobody who lost was charged.`, false);
}

// ---------------------------------------------------------------- queue handlers

export const handlers: Handlers = {
  async run(op: OpRow) {
    const e = getEntry(op.entry_id);
    if (!e) return;
    const drop = getDrop(e.drop_id)!;
    const payload = JSON.parse(op.payload) as { injectFailure?: boolean; reason?: string; authorizationId?: string };
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
        .prepare("UPDATE entries SET status = 'held', authorization_id = ?, hold_cents = ?, updated_at = ? WHERE id = ? AND status = 'authorizing'")
        .run(r.authorizationId, drop.price_cents + drop.ship_hold_cents, now(), e.id);
      if (!placed.changes || !dropIsOpen(getDrop(drop.id)!)) {
        // the drop was drawn while PayPal was authorizing: release this hold immediately
        updateEntry(e.id, { status: "voided", authorization_id: r.authorizationId, note: "The drop closed while the hold was being placed — released." });
        enqueue("void", `void:${r.authorizationId}`, e.id, { reason: "drop closed during authorization", authorizationId: r.authorizationId });
        return;
      }
      emit(drop.id, "hold_placed", `Hold placed for ${e.public_id}: ${formatUsd(drop.price_cents + drop.ship_hold_cents)} authorized (${r.status}). Nothing charged yet.`, true, {
        authorizationId: r.authorizationId,
      });
    } else if (op.kind === "capture") {
      if (e.status !== "won") return;
      if (payload.injectFailure) {
        // Sandbox negative test, clearly labelled in the UI: release the hold first, then attempt the capture.
        // PayPal answers 422 AUTHORIZATION_VOIDED — the same path a lapsed/declined hold takes in production.
        await paypal.voidAuthorizationSafe(e.authorization_id!, `negtest:${e.authorization_id}`);
        emit(drop.id, "negative_test", `SANDBOX NEGATIVE TEST: hold for ${e.public_id} released before capture to reproduce a failed payment.`, true);
      }
      const r = await paypal.captureAuthorization(e.authorization_id!, captureAmount(drop), op.key, `PAYLET-${e.id.slice(-10)}-1`);
      if (r.status === "PENDING") {
        updateEntry(e.id, { capture_id: r.captureId ?? null, note: "Payment pending at PayPal — waiting for confirmation." });
        emit(drop.id, "capture_pending", `Capture for ${e.public_id} is PENDING at PayPal.`, true);
        return;
      }
      if (r.status !== "COMPLETED") throw new Error(`CAPTURE_${r.status || "UNKNOWN"}`);
      updateEntry(e.id, { status: "captured", capture_id: r.captureId ?? null, captured_cents: captureAmount(drop) });
      emit(
        drop.id,
        "captured",
        `Captured ${formatUsd(captureAmount(drop))} from ${e.public_id} (held ${formatUsd(drop.price_cents + drop.ship_hold_cents)} — ${formatUsd(drop.ship_hold_cents - drop.ship_actual_cents)} of unused shipping released).`,
        true,
        { captureId: r.captureId },
      );
      settleIfDone(drop.id);
    } else if (op.kind === "void") {
      const authId = e.authorization_id ?? payload.authorizationId;
      if (!authId) return;
      const r = await paypal.voidAuthorizationSafe(authId, op.key);
      if (e.status !== "merged" && e.status !== "capture_failed") updateEntry(e.id, { status: "voided" });
      emit(drop.id, "voided", `Hold released for ${e.public_id} (${payload.reason ?? "not selected"}) — ${r.already ? "already released" : "voided"}, never charged.`, true);
    }
  },
  async onTerminal(op, f) {
    const e = getEntry(op.entry_id);
    if (!e) return;
    if (op.kind === "authorize") {
      updateEntry(e.id, { status: "error", note: `PayPal could not place the hold (${f.issue}).` });
      emit(e.drop_id, "authorize_failed", `Hold failed for ${e.public_id}: ${f.status} ${f.issue}.`, true);
    } else if (op.kind === "capture") {
      if (f.cls === "CONFIG") {
        // our credentials/permissions are broken: do NOT burn through the waitlist — retry later
        db.prepare("UPDATE ops SET status = 'pending', attempts = 0, next_at = ? WHERE key = ?").run(now() + 10 * 60_000, op.key);
        emit(e.drop_id, "capture_blocked", `Capture for ${e.public_id} blocked by a configuration error (${f.status} ${f.issue}); retrying in 10 minutes.`, true);
        return;
      }
      // reconcile with PayPal before declaring the payment failed
      try {
        const a = await paypal.getAuthorization(e.authorization_id!);
        if (a.status === "CAPTURED" || a.status === "PARTIALLY_CAPTURED") {
          const drop = getDrop(e.drop_id)!;
          updateEntry(e.id, { status: "captured", captured_cents: captureAmount(drop) });
          emit(e.drop_id, "captured", `Capture for ${e.public_id} confirmed by reconciliation with PayPal.`, true);
          settleIfDone(e.drop_id);
          return;
        }
        if (a.status === "CREATED" || a.status === "PENDING") enqueue("void", `void:${e.authorization_id}`, e.id, { reason: "payment failed" });
      } catch {
        /* reconciliation is best-effort; the sweeper re-arms failed voids */
      }
      updateEntry(e.id, { status: "capture_failed", note: `Payment failed (${f.issue}). The unit passes to the waitlist.` });
      emit(e.drop_id, "capture_failed", `Capture failed for ${e.public_id}: PayPal ${f.status} ${f.issue}. Promoting waitlist.`, true);
      await promoteNext(e.drop_id);
    } else {
      emit(e.drop_id, "void_failed", `Void failed for ${e.public_id}: ${f.status} ${f.issue} (the sweeper will retry).`, true);
    }
  },
};

// ---------------------------------------------------------------- sweeper

/** GETs are the source of truth: reconcile approvals that never reached /finalize (agent tabs closed, webhooks late). */
export async function sweep(): Promise<void> {
  const stale = db
    .prepare(
      "SELECT * FROM entries WHERE status = 'awaiting_person' AND order_id IS NOT NULL AND created_at < ? AND created_at > ? AND updated_at < ? ORDER BY updated_at LIMIT 3",
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
  // Any real hold still "held" in a drop that is no longer open is outside the ballot: release it.
  const strays = db
    .prepare("SELECT e.* FROM entries e JOIN drops d ON d.id = e.drop_id WHERE e.status = 'held' AND e.source <> 'simulated' AND d.status <> 'open' LIMIT 5")
    .all() as unknown as EntryRow[];
  for (const e of strays) {
    updateEntry(e.id, { status: "lost", note: "Hold placed outside the ballot — released." });
    scheduleVoid(getDrop(e.drop_id)!, getEntry(e.id)!, "outside the ballot");
  }
  // Re-arm voids that failed terminally (voidAuthorizationSafe GETs first, so this is idempotent).
  db.prepare(
    "UPDATE ops SET status = 'pending', attempts = 0, next_at = ? WHERE key IN (SELECT key FROM ops WHERE kind = 'void' AND status = 'failed' AND updated_at < ? AND created_at > ? ORDER BY updated_at LIMIT 3)",
  ).run(now(), now() - 10 * 60_000, now() - 28 * 86_400_000);
  // Expire open drops past their close time (judge drops close after 30 min).
  const expired = db.prepare("SELECT id FROM drops WHERE status = 'open' AND closes_at < ?").all(now()) as { id: string }[];
  for (const d of expired) {
    try {
      await draw(d.id);
    } catch (err) {
      console.warn("auto-draw", d.id, String(err));
    }
  }
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
    note: e.note,
    explanation: e.explanation,
    drop: { slug: d.slug, title: d.title, maker: d.maker, status: d.status, closesAt: d.closes_at, units: d.units, art: d.art },
  };
}

export function fileAppeal(entryId: string, message: string) {
  const e = getEntry(entryId);
  if (!e) throw new HttpError(404, "entry_not_found");
  db.prepare("INSERT INTO appeals(id, drop_id, entry_id, message, status, created_at) VALUES(?, ?, ?, ?, 'open', ?)").run(id("apl", 6), e.drop_id, e.id, message.slice(0, 600), now());
  if (e.cluster_id) db.prepare("UPDATE clusters SET status = 'suggested' WHERE id = ? AND status = 'confirmed'").run(e.cluster_id);
  emit(e.drop_id, "appeal", `Appeal filed by ${e.public_id}: "${message.slice(0, 80)}" — cluster returned to the seller for review.`, false);
}
