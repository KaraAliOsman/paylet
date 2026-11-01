// Entity resolution = deterministic rules decide the obvious cases, the LLM adjudicates only the fuzzy ones,
// and the SELLER confirms every cluster before it affects the draw. Nothing is auto-collapsed.
//
// The model only ever sees public labels (never internal entry ids), and its answer is validated with zod.
// A failed or invalid answer for one group of entries is retried once and then skipped: the other groups are
// still reviewed, the skipped pairs simply stay unmerged, and `degraded` says so in plain words.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Identity } from "./normalize";
import { allPairs, components, formatDuration, isAutomated, prepare, type PairScore, type Prepared } from "./rules";

export interface ResolvedCluster {
  memberIds: string[];
  kind: "household" | "operator";
  method: "rules" | "ai";
  confidence: number;
  /** At most one item per field (address, email, name, care_of, timing…), model wording first. */
  evidence: { field: string; detail: string }[];
  explanation: string;
  /** Normalised address shared by most members, e.g. "1200 HARBOR BLVD STE 4B 43215" (null if no two members share one). */
  normalizedKey: string | null;
}

/** An uncertain pair the model reviewed and decided NOT to link. `a`/`b` are public labels, never internal ids. */
export interface KeptApart {
  a: string;
  b: string;
  reason: string;
  /** Model confidence (0–1) that these are different people/households. */
  confidence: number;
}

export interface ResolveResult {
  clusters: ResolvedCluster[];
  links: [string, string][];
  llmCalls: number;
  uncertainPairs: number;
  /** Uncertain pairs the model reviewed and kept apart, closest calls first (highest rule score, then confidence). */
  keptApart: KeptApart[];
  /** Uncertain pairs the model could not review (AI failure) — they stay unmerged. */
  unreviewedPairs: number;
  /** Plain-language note when the AI review was incomplete; null when every uncertain pair was reviewed. */
  degraded: string | null;
  /** @deprecated short technical reason, kept for older callers; use `degraded`. */
  aiDegraded?: string;
}

/** One model call. Injectable so evals can record/replay the exact responses and tests can run offline. */
export interface AdjudicationRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
}
export type Adjudicator = (req: AdjudicationRequest) => Promise<unknown>;

/** Default adjudicator: the configured OpenAI-compatible model (lazy import keeps env/db out of offline evals). */
export const llmAdjudicator: Adjudicator = async (req) => {
  const { chatJson } = await import("../ai");
  return chatJson<unknown>(
    "er_adjudicate",
    [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    req.schemaName,
    req.schema,
  );
};

export interface ResolveOptions {
  useLlm: boolean;
  adjudicator?: Adjudicator;
  /** Max entries per model call (default 12). */
  chunkSize?: number;
  /** Attempts per chunk before giving up on it (default 2). */
  attempts?: number;
}

// ---------------------------------------------------------------- model contract

const LLM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["groups", "kept_apart"],
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["member_ids", "verdict", "confidence", "evidence", "explanation"],
        properties: {
          member_ids: { type: "array", items: { type: "string" } },
          verdict: { type: "string", enum: ["same_household", "same_operator", "distinct"] },
          confidence: { type: "number" },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["field", "detail"],
              properties: { field: { type: "string" }, detail: { type: "string" } },
            },
          },
          explanation: { type: "string" },
        },
      },
    },
    kept_apart: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["a", "b", "reason", "confidence"],
        properties: { a: { type: "string" }, b: { type: "string" }, reason: { type: "string" }, confidence: { type: "number" } },
      },
    },
  },
};

// Confidence may come back as 0–1 or 0–100; anything else is an invalid answer.
const Confidence = z
  .number()
  .min(0)
  .max(100)
  .transform((c) => (c > 1 ? c / 100 : c));

const LlmAnswer = z.object({
  groups: z.array(
    z.object({
      member_ids: z.array(z.string()).min(1),
      verdict: z.enum(["same_household", "same_operator", "distinct"]),
      confidence: Confidence,
      evidence: z.array(z.object({ field: z.string(), detail: z.string() })).default([]),
      explanation: z.string().default(""),
    }),
  ),
  kept_apart: z.array(z.object({ a: z.string(), b: z.string(), reason: z.string(), confidence: Confidence })).default([]),
});
type LlmAnswer = z.infer<typeof LlmAnswer>;
type LlmGroup = LlmAnswer["groups"][number];

/** Below this the model's "same" verdict is not acted on (the pair is kept apart). */
const MIN_LINK_CONFIDENCE = 0.6;

export const SYSTEM = `You are the entity-resolution adjudicator for Paylet, a fair-allocation ballot for limited product drops.
Every entry below is a DIFFERENT PayPal account that placed a hold. The rule is one unit per person/household/operation.
Decide which entries are controlled by the same household or the same reseller operation.

Guidelines:
- Same street address AND same unit/suite (after normalisation) => same place. Different names at one freight-forwarder suite => "same_operator".
- People sharing a single-family home address (no unit) => "same_household".
- Neighbours in DIFFERENT apartment numbers of one building are DISTINCT unless another strong signal links them.
- Identical common names in different cities are DISTINCT.
- A shared mailbox_token means the same mailbox (aliases already normalised) => same person.
- c/o or "Attn" routing at a commercial address is typical of reshippers.
- address_as_typed is what the buyer typed; street/unit/zip are our normalisation of it. If they disagree, trust what was typed.
- entered_via says how the entry arrived: "human", "agent" (an AI agent / API client) or "simulated" (a scripted demo entrant). Never call a human or simulated entry an agent.
- Pairs with rule_score >= 0.85 are already linked by deterministic rules; you decide the others.
- Be conservative: if you are not reasonably sure, return "distinct". A false merge takes a real fan's chance away.
Return groups that partition the given member ids (singletons as "distinct").
Then, for EVERY pair in deterministic_signals whose two entries you did NOT put in the same group, add a kept_apart item with
a one-sentence reason a seller would understand (name the field that differs, e.g. "different apartments (2A vs 5C), unrelated surnames")
and your confidence (0-1) that they are different people or households.
Evidence must cite concrete fields (address, unit, name, mailbox_token, timing, care_of), one field per evidence item.
Describe timing only relatively (e.g. "six entries within 12 seconds"); never quote clock times or dates.
Never quote mailbox_token values; say "same mailbox" or "different mailboxes". Refer to entries by their id.
Keep every evidence detail and every kept_apart reason under 20 words, and explanations to one sentence a fan would understand.`;

class InvalidAnswer extends Error {}

function mailboxToken(email: string): string {
  return email ? createHash("sha256").update(email).digest("hex").slice(0, 6) : "";
}

const labelOf = (p: Prepared) => p.raw.label ?? p.id;

function enteredVia(i: Identity): string {
  if (i.source === "simulated") return i.agentLabel ? "simulated (scripted bot)" : "simulated";
  if (i.source === "agent") return "agent";
  return i.source ?? "human";
}

function view(p: Prepared, t0: number | null) {
  return {
    id: labelOf(p),
    name: p.raw.name,
    address_as_typed: [p.raw.address.line1, p.raw.address.line2].filter(Boolean).join(", "),
    street: p.addr.street,
    unit: p.addr.unit || null,
    city: p.addr.city,
    state: p.addr.state,
    zip: p.addr.zip5,
    care_of: p.addr.careOf || null,
    mailbox_token: mailboxToken(p.email) || null,
    entered_via: enteredVia(p.raw),
    // relative only: the model never sees (or quotes) a wall-clock time
    seconds_after_first_entry: p.raw.ts && t0 != null ? Math.round((p.raw.ts - t0) / 1000) : null,
  };
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Normalised address key used by the address-diff UI. */
export function addressKey(p: Prepared): string {
  return [p.addr.street, p.addr.unit ? `STE ${p.addr.unit}` : "", p.addr.zip5].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- evidence (one item per field)

const FIELD_ALIASES: Record<string, string> = {
  mailbox_token: "email", mailbox: "email", street: "address", unit: "address", zip: "address", city: "address",
  suite: "address", apartment: "address", care: "care_of", "c/o": "care_of", attn: "care_of", time: "timing", entered_at: "timing",
};
const FIELD_ORDER = ["address", "email", "name", "care_of", "timing"];

/** "address / unit / care_of" -> "address": compound labels count as their first field. */
function fieldOf(f: string): string {
  const k = f.trim().toLowerCase().split(/\s*(?:\/|,|&|\+|\band\b)\s*/)[0] || "other";
  return FIELD_ALIASES[k] ?? k;
}

function clusterEvidence(ids: string[], aiEvidence: { field: string; detail: string }[], pairs: PairScore[], byId: Map<string, Prepared>) {
  const out = new Map<string, string>();
  for (const e of aiEvidence) {
    const f = fieldOf(e.field);
    if (!out.has(f) && e.detail.trim()) out.set(f, e.detail.trim());
  }
  // rule signals: for each field, the most frequent (then strongest) detail across the member pairs
  const tally = new Map<string, Map<string, { n: number; w: number }>>();
  for (const p of pairs) {
    if (!ids.includes(p.a) || !ids.includes(p.b)) continue;
    for (const s of p.signals) {
      if (s.field === "timing") continue; // summarised once for the whole cluster below
      const m = tally.get(s.field) ?? new Map();
      const t = m.get(s.detail) ?? { n: 0, w: s.weight };
      t.n++;
      m.set(s.detail, t);
      tally.set(s.field, m);
    }
  }
  for (const [field, details] of tally) {
    if (out.has(field)) continue;
    const best = [...details.entries()].sort((x, y) => y[1].n - x[1].n || y[1].w - x[1].w)[0];
    out.set(field, best[0]);
  }
  if (!out.has("timing")) {
    const auto = ids.map((id) => byId.get(id)!.raw).filter((r) => r.ts && isAutomated(r));
    if (auto.length >= 2) {
      const ts = auto.map((r) => r.ts!);
      const span = Math.max(...ts) - Math.min(...ts);
      if (span < 15_000 * auto.length) {
        const who = auto.some((r) => r.source === "simulated") ? "simulated bot entries" : "agent entries";
        out.set("timing", `${auto.length} ${who} within ${formatDuration(span)}`);
      }
    }
  }
  const rank = (f: string) => (FIELD_ORDER.indexOf(f) + 1 || 99);
  return [...out.entries()]
    .sort((x, y) => rank(x[0]) - rank(y[0]))
    .slice(0, 6)
    .map(([field, detail]) => ({ field, detail }));
}

// ---------------------------------------------------------------- resolve

interface ChunkOutcome {
  chunk: string[];
  answer: LlmAnswer | null;
  error: string | null;
  fatal: boolean;
}

function isFatal(e: unknown): boolean {
  const name = (e as { constructor?: { name?: string } })?.constructor?.name;
  const msg = e instanceof Error ? e.message : String(e);
  return name === "BudgetExceeded" || /budget reached|not configured/i.test(msg);
}

/** Best-first traversal of a component (highest rule score edge next), so splitting it keeps close pairs together. */
function strongestFirst(comp: string[], scored: PairScore[]): string[] {
  const inComp = new Set(comp);
  const adj = new Map<string, { to: string; score: number }[]>();
  for (const p of scored) {
    if (!inComp.has(p.a) || !inComp.has(p.b)) continue;
    adj.set(p.a, [...(adj.get(p.a) ?? []), { to: p.b, score: p.score }]);
    adj.set(p.b, [...(adj.get(p.b) ?? []), { to: p.a, score: p.score }]);
  }
  const order: string[] = [];
  const seen = new Set<string>();
  for (const start of comp) {
    if (seen.has(start)) continue;
    const frontier = [{ to: start, score: Infinity }];
    while (frontier.length) {
      frontier.sort((x, y) => y.score - x.score);
      const { to } = frontier.shift()!;
      if (seen.has(to)) continue;
      seen.add(to);
      order.push(to);
      for (const e of adj.get(to) ?? []) if (!seen.has(e.to)) frontier.push(e);
    }
  }
  return order;
}

function shortError(e: unknown): string {
  return String(e instanceof Error ? e.message : e).replace(/\s+/g, " ").slice(0, 120);
}

export async function resolve(list: Identity[], opts: ResolveOptions = { useLlm: true }): Promise<ResolveResult> {
  const prepared = prepare(list);
  const byId = new Map(prepared.map((p) => [p.id, p]));
  const pairs = allPairs(prepared);
  const certain = pairs.filter((p) => p.band === "link");
  const uncertain = pairs.filter((p) => p.band === "uncertain");
  const adjudicate = opts.adjudicator ?? llmAdjudicator;
  const chunkSize = opts.chunkSize ?? 12;
  const attempts = Math.max(1, opts.attempts ?? 2);

  const links: [string, string][] = certain.map((p) => [p.a, p.b]);
  const aiGroups: { ids: string[]; g: LlmGroup }[] = [];
  const outcomes: ChunkOutcome[] = [];
  let llmCalls = 0;
  let stopReason: string | null = null;

  if (opts.useLlm && uncertain.length) {
    // Components over all non-trivial pairs, adjudicated one chunk (≤ chunkSize members) at a time.
    const inUncertain = new Set(uncertain.flatMap((u) => [u.a, u.b]));
    const comps = components(
      prepared.map((p) => p.id),
      [...certain, ...uncertain].map((p) => [p.a, p.b] as [string, string]),
    ).filter((c) => c.some((id) => inUncertain.has(id)));
    const chunks = comps.flatMap((comp) => {
      if (comp.length <= chunkSize) return [comp];
      // Too big for one call: walk strongest pairs first so look-alikes land in the same chunk.
      const order = strongestFirst(comp, [...certain, ...uncertain]);
      return Array.from({ length: Math.ceil(order.length / chunkSize) }, (_, i) => order.slice(i * chunkSize, (i + 1) * chunkSize));
    });

    let consecutiveFailures = 0;
    for (const chunk of chunks) {
      if (stopReason) {
        outcomes.push({ chunk, answer: null, error: stopReason, fatal: true });
        continue;
      }
      const inChunk = new Set(chunk);
      const fromLabel = new Map(chunk.map((id) => [labelOf(byId.get(id)!), id]));
      const signals = pairs
        .filter((p) => inChunk.has(p.a) && inChunk.has(p.b))
        .map((p) => ({ a: labelOf(byId.get(p.a)!), b: labelOf(byId.get(p.b)!), rule_score: p.score, signals: p.signals.map((s) => s.detail) }));
      const stamps = chunk.map((id) => byId.get(id)!.raw.ts).filter((t): t is number => typeof t === "number" && t > 0);
      const t0 = stamps.length ? Math.min(...stamps) : null;
      const req: AdjudicationRequest = {
        system: SYSTEM,
        user: JSON.stringify({ entries: chunk.map((id) => view(byId.get(id)!, t0)), deterministic_signals: signals }),
        schemaName: "er_groups",
        schema: LLM_SCHEMA,
      };

      let answer: LlmAnswer | null = null;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < attempts && !answer; attempt++) {
        try {
          llmCalls++;
          const parsed = LlmAnswer.safeParse(await adjudicate(req));
          if (!parsed.success) throw new InvalidAnswer(`invalid model answer: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
          // semantic check: an entry may belong to at most one linking group
          const seen = new Set<string>();
          for (const g of parsed.data.groups) {
            if (g.verdict === "distinct") continue;
            for (const m of g.member_ids) {
              const id = fromLabel.get(m);
              if (!id) continue;
              if (seen.has(id)) throw new InvalidAnswer("invalid model answer: one entry placed in two groups");
              seen.add(id);
            }
          }
          answer = parsed.data;
        } catch (e) {
          lastErr = e;
          if (isFatal(e)) break;
        }
      }
      if (!answer) {
        const fatal = isFatal(lastErr);
        outcomes.push({ chunk, answer: null, error: shortError(lastErr), fatal });
        consecutiveFailures++;
        // stop calling a model that is out of budget, unconfigured, or clearly down; keep going after a one-off failure
        if (fatal || consecutiveFailures >= 3) stopReason = shortError(lastErr);
        continue;
      }
      consecutiveFailures = 0;
      outcomes.push({ chunk, answer, error: null, fatal: false });
      for (const g of answer.groups) {
        const ids = [...new Set(g.member_ids.map((m) => fromLabel.get(m)).filter((id): id is string => !!id))];
        if (ids.length < 2 || g.verdict === "distinct" || g.confidence < MIN_LINK_CONFIDENCE) continue;
        aiGroups.push({ ids, g });
        for (let k = 1; k < ids.length; k++) links.push([ids[0], ids[k]]);
      }
    }
  }

  // ------------------------------------------------ clusters
  const finalGroups = components(
    prepared.map((p) => p.id),
    links,
  );
  const groupOf = new Map<string, number>();
  finalGroups.forEach((g, i) => g.forEach((id) => groupOf.set(id, i)));

  const clusters: ResolvedCluster[] = finalGroups.map((ids) => {
    const ais = aiGroups.filter((x) => x.ids.some((id) => ids.includes(id)));
    const ai = ais.sort((x, y) => y.ids.length - x.ids.length || y.g.confidence - x.g.confidence)[0];
    const memberPairs = pairs.filter((p) => ids.includes(p.a) && ids.includes(p.b));
    const operatorish = ai
      ? ai.g.verdict === "same_operator"
      : ids.some((id) => byId.get(id)?.addr.careOf) || new Set(ids.map((id) => byId.get(id)!.name.at(-1))).size > 1;
    const certainOnly = !ai && ids.every((id) => certain.some((c) => c.a === id || c.b === id));
    const conf = ai ? Math.round(ai.g.confidence * 100) / 100 : Math.max(0, ...memberPairs.map((p) => p.score));
    const keys = new Map<string, number>();
    for (const id of ids) {
      const k = addressKey(byId.get(id)!);
      keys.set(k, (keys.get(k) ?? 0) + 1);
    }
    const [topKey, topN] = [...keys.entries()].sort((x, y) => y[1] - x[1])[0];
    return {
      memberIds: ids,
      kind: operatorish ? "operator" : "household",
      method: certainOnly ? "rules" : "ai",
      confidence: conf,
      evidence: clusterEvidence(ids, ai?.g.evidence ?? [], pairs, byId),
      explanation:
        ai?.g.explanation ||
        (operatorish
          ? `These ${ids.length} PayPal accounts ship to the same normalised address and unit.`
          : `These ${ids.length} PayPal accounts share one household address.`),
      normalizedKey: topN >= 2 ? topKey : null,
    };
  });

  // ------------------------------------------------ kept apart (reviewed by the model, not linked)
  const reviewed = new Map<string, LlmAnswer>(); // pairKey -> answer of the chunk that contained both ids
  const unreviewed = new Set<string>();
  for (const u of uncertain) unreviewed.add(pairKey(u.a, u.b));
  for (const o of outcomes) {
    if (!o.answer) continue;
    const inChunk = new Set(o.chunk);
    for (const u of uncertain) if (inChunk.has(u.a) && inChunk.has(u.b)) {
      reviewed.set(pairKey(u.a, u.b), o.answer);
      unreviewed.delete(pairKey(u.a, u.b));
    }
  }
  const keptApart: (KeptApart & { score: number })[] = [];
  for (const u of uncertain) {
    const answer = reviewed.get(pairKey(u.a, u.b));
    if (!answer) continue;
    const ga = groupOf.get(u.a);
    if (ga !== undefined && ga === groupOf.get(u.b)) continue; // linked (directly or through others)
    const la = labelOf(byId.get(u.a)!);
    const lb = labelOf(byId.get(u.b)!);
    const said = answer.kept_apart.find((k) => pairKey(k.a.trim(), k.b.trim()) === pairKey(la, lb));
    const unsure = answer.groups.find((g) => g.verdict !== "distinct" && g.member_ids.includes(la) && g.member_ids.includes(lb));
    const single = answer.groups.filter((g) => g.verdict === "distinct" && (g.member_ids.includes(la) || g.member_ids.includes(lb)));
    let reason: string;
    let confidence: number;
    if (said && said.reason.trim()) {
      reason = said.reason.trim();
      confidence = said.confidence;
    } else if (unsure) {
      reason = `The model leaned towards linking them but was only ${Math.round(unsure.confidence * 100)}% sure, so they stay separate.`;
      confidence = Math.round((1 - unsure.confidence) * 100) / 100;
    } else {
      reason = `Not linked by the model; rules only saw: ${u.signals.map((s) => s.detail).join("; ")}.`;
      confidence = single.length ? Math.min(...single.map((g) => g.confidence)) : 0.5;
    }
    keptApart.push({ a: la, b: lb, reason, confidence: Math.round(confidence * 100) / 100, score: u.score });
  }
  keptApart.sort((x, y) => y.score - x.score || y.confidence - x.confidence);

  // ------------------------------------------------ degraded mode (plain words; technical detail in aiDegraded)
  const failed = outcomes.filter((o) => !o.answer);
  let degraded: string | null = null;
  let aiDegraded: string | undefined;
  if (opts.useLlm && failed.length) {
    aiDegraded = failed[0].error ?? "unknown error";
    const n = uncertain.filter((u) => failed.some((o) => o.chunk.includes(u.a) && o.chunk.includes(u.b))).length;
    const pairsTxt = `${n} uncertain pair${n === 1 ? "" : "s"} ${n === 1 ? "was" : "were"} not reviewed and stay${n === 1 ? "s" : ""} unmerged`;
    const why = /budget reached/i.test(aiDegraded)
      ? "The daily AI budget is used up"
      : /not configured/i.test(aiDegraded)
        ? "The AI reviewer is not configured"
        : failed.length === outcomes.length
          ? "The AI reviewer is unavailable right now"
          : `The AI reviewer could not answer for ${failed.length} of ${outcomes.length} groups`;
    degraded = `${why}: ${pairsTxt}. Rule-certain clusters are unaffected.`;
  }

  return {
    clusters,
    links,
    llmCalls,
    uncertainPairs: uncertain.length,
    keptApart: keptApart.map(({ score: _score, ...k }) => k),
    unreviewedPairs: opts.useLlm ? unreviewed.size : uncertain.length,
    degraded,
    aiDegraded,
  };
}
