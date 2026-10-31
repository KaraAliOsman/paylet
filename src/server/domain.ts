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
      requests: entries.length,
      awaitingPerson: count((e) => e.status === "awaiting_person"),
      holds: count((e) => e.hold_cents != null && e.status !== "duplicate"),
      duplicatesBlocked: count((e) => e.status === "duplicate"),
      merged: count((e) => e.status === "merged"),
      simulated: count((e) => e.source === "simulated"),
      agents: count((e) => e.source === "agent"),
      captured: count((e) => e.status === "captured"),
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

/** Called after the person approves in PayPal (button onApprove, agent return URL, webhook, or sweeper). */
export async function finalize(orderId: string): Promise<{ outcome: FinalizeOutcome; entry?: EntryRow }> {
  const entry = getEntryByOrder(orderId);
  if (!entry) return { outcome: "unknown_order" };
  if (entry.status !== "awaiting_person") return { outcome: "already", entry };
  const drop = getDrop(entry.drop_id)!;

  const ident = await paypal.getOrderIdentity(orderId);
  emit(drop.id, "order_checked", `GET order for ${entry.public_id}: ${ident.status}`, true);
  if (ident.status !== "APPROVED") return { outcome: "not_approved", entry };
  if (!dropIsOpen(drop)) {
    updateEntry(entry.id, { status: "expired", note: "approved after the drop closed — no hold placed" });
    return { outcome: "closed", entry: getEntry(entry.id) };
  }

  const anchor = ident.payerId ?? ident.accountId;
  if (!anchor) {
    updateEntry(entry.id, { status: "error", note: "PayPal returned no payer id" });
    return { outcome: "not_approved", entry: getEntry(entry.id) };
  }
  const payerHash = hmac(`payer:${anchor}`);
  const identity = {
    payer_hash: payerHash,
    account_hash: ident.accountId ? hmac(`acct:${ident.accountId}`) : null,
    email_hash: ident.email ? hmac(`email:${ident.email.toLowerCase()}`) : null,
    name: ident.name ?? null,
    display_name: ident.name ? `${ident.name.split(" ")[0]} ${(ident.name.split(" ")[1] ?? "").slice(0, 1)}.`.trim() : null,
    email: ident.email ?? null,
    address_json: ident.address ? JSON.stringify(ident.address) : null,
  };

  try {
    tx(() => {
      updateEntry(entry.id, { ...identity, status: "authorizing" });
    });
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      updateEntry(entry.id, {
        ...identity,
        payer_hash: null,
        status: "duplicate",
        note: "This PayPal account already holds an entry in this drop — no hold placed.",
      });
      // keep the hash for analytics without violating the unique index
      db.prepare("UPDATE entries SET account_hash = ? WHERE id = ?").run(identity.account_hash, entry.id);
      emit(drop.id, "duplicate_blocked", `Entry ${entry.public_id}: same PayPal account as an existing entry → no hold placed.`, true, { source: entry.source });
      return { outcome: "duplicate", entry: getEntry(entry.id) };
    }
    throw e;
  }
  enqueue("authorize", `auth:${entry.id}`, entry.id);
  return { outcome: "authorizing", entry: getEntry(entry.id) };
}

// ---------------------------------------------------------------- simulated crowd

export function addSimulatedCrowd(dropIdOrSlug: string, seed = Math.floor(Math.random() * 1e6)) {
  const drop = getDrop(dropIdOrSlug);
  if (!drop) throw new HttpError(404, "drop_not_found");
  if (!dropIsOpen(drop)) throw new HttpError(409, "drop_closed");
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
    name: e.name ?? "",
    email: e.email,
    address: JSON.parse(e.address_json),
    ts: e.created_at,
    source: e.source === "simulated" && e.agent_label ? "agent" : e.source,
    agentLabel: e.agent_label,
  };
}

export async function analyzeDrop(dropIdOrSlug: string) {
  const drop = getDrop(dropIdOrSlug);
  if (!drop) throw new HttpError(404, "drop_not_found");
  const entries = listEntries(drop.id).filter((e) => e.status === "held" || e.status === "authorizing");
  const identities = entries.map(identityOf).filter((x): x is Identity => !!x);
  const t0 = Date.now();
  const result = await resolve(identities, { useLlm: true });
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
    `Entity resolution: ${identities.length} entries, ${result.uncertainPairs} fuzzy pairs sent to the AI (${result.llmCalls} call${result.llmCalls === 1 ? "" : "s"}), ${result.clusters.length} cluster(s) suggested in ${(ms / 1000).toFixed(1)}s. Seller must confirm.`,
    false,
  );
  return { ...result, ms };
}

export function decideCluster(clusterId: string, decision: "confirmed" | "dismissed") {
  const c = db.prepare("SELECT * FROM clusters WHERE id = ?").get(clusterId) as ClusterRow | undefined;
  if (!c) throw new HttpError(404, "cluster_not_found");
  db.prepare("UPDATE clusters SET status = ? WHERE id = ?").run(decision, clusterId);
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
        explanation: `${c.explanation} One allocation per ${c.kind === "operator" ? "operation" : "household"} — your hold is released.`,
      });
    }
    if (members[0]) updateEntry(members[0].id, { cluster_id: c.id });
  }
  const eligible = held.filter((e) => !mergedIds.has(e.id));
  const ids = eligible.map((e) => e.public_id);
  const frozenHash = await sha256Hex(canonicalList(ids));
  const result = await computeDraw(drop.seed, ids, drop.units, drop.waitlist_size);
  const byPid = new Map(eligible.map((e) => [e.public_id, e]));

  db.prepare("UPDATE drops SET status = 'drawn', frozen_hash = ?, frozen_list = ?, drawn_at = ? WHERE id = ?").run(
    frozenHash,
    JSON.stringify([...ids].sort()),
    now(),
    drop.id,
  );
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
  let failInjected = false;
  for (const pid of result.winners) {
    const e = getEntry(byPid.get(pid)!.id)!;
    const inject = drop.negative_test === 1 && !failInjected && e.source !== "simulated";
    if (inject) failInjected = true;
    scheduleCapture(drop, e, inject);
  }
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
    const payload = JSON.parse(op.payload) as { injectFailure?: boolean; reason?: string };
    if (op.kind === "authorize") {
      const r = await paypal.authorizeOrder(e.order_id!, op.key);
      updateEntry(e.id, { status: "held", authorization_id: r.authorizationId ?? null, hold_cents: drop.price_cents + drop.ship_hold_cents });
      emit(drop.id, "hold_placed", `Hold placed for ${e.public_id}: ${formatUsd(drop.price_cents + drop.ship_hold_cents)} authorized (${r.status}). Nothing charged yet.`, true, {
        authorizationId: r.authorizationId,
      });
    } else if (op.kind === "capture") {
      if (payload.injectFailure) {
        // Sandbox negative test, clearly labelled in the UI: release the hold first, then attempt the capture.
        // PayPal answers 422 AUTHORIZATION_VOIDED — the same path a lapsed/declined hold takes in production.
        await paypal.voidAuthorizationSafe(e.authorization_id!, `negtest:${e.authorization_id}`);
        emit(drop.id, "negative_test", `SANDBOX NEGATIVE TEST: hold for ${e.public_id} released before capture to reproduce a failed payment.`, true);
      }
      const r = await paypal.captureAuthorization(e.authorization_id!, captureAmount(drop), op.key, `PAYLET-${e.id.slice(-10)}-1`);
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
      const r = await paypal.voidAuthorizationSafe(e.authorization_id!, op.key);
      if (e.status !== "merged") updateEntry(e.id, { status: "voided" });
      emit(drop.id, "voided", `Hold released for ${e.public_id} (${payload.reason ?? "not selected"}) — ${r.already ? "already released" : "voided"}, never charged.`, true);
    }
  },
  onTerminal(op, f) {
    const e = getEntry(op.entry_id);
    if (!e) return;
    if (op.kind === "authorize") {
      updateEntry(e.id, { status: "error", note: `PayPal could not place the hold (${f.issue}).` });
      emit(e.drop_id, "authorize_failed", `Hold failed for ${e.public_id}: ${f.status} ${f.issue}.`, true);
    } else if (op.kind === "capture") {
      updateEntry(e.id, { status: "capture_failed", note: `Payment failed (${f.issue}). The unit passes to the waitlist.` });
      emit(e.drop_id, "capture_failed", `Capture failed for ${e.public_id}: PayPal ${f.status} ${f.issue}. Promoting waitlist.`, true);
      void promoteNext(e.drop_id);
    } else {
      emit(e.drop_id, "void_failed", `Void failed for ${e.public_id}: ${f.status} ${f.issue} (hold will lapse on its own).`, true);
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
      await finalize(e.order_id!);
    } catch (err) {
      console.warn("sweep", e.id, paypal.classify(err).issue);
    }
  }
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
