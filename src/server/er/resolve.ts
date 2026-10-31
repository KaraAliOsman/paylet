// Entity resolution = deterministic rules decide the obvious cases, the LLM adjudicates only the fuzzy ones,
// and the SELLER confirms every cluster before it affects the draw. Nothing is auto-collapsed.
import { createHash } from "node:crypto";
import { chatJson } from "../ai";
import type { Identity } from "./normalize";
import { allPairs, components, prepare, type PairScore, type Prepared } from "./rules";

export interface ResolvedCluster {
  memberIds: string[];
  kind: "household" | "operator";
  method: "rules" | "ai";
  confidence: number;
  evidence: { field: string; detail: string }[];
  explanation: string;
}

export interface ResolveResult {
  clusters: ResolvedCluster[];
  links: [string, string][];
  llmCalls: number;
  uncertainPairs: number;
}

interface LlmGroup {
  member_ids: string[];
  verdict: "same_household" | "same_operator" | "distinct";
  confidence: number;
  evidence: { field: string; detail: string }[];
  explanation: string;
}

const LLM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["groups"],
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
  },
};

const SYSTEM = `You are the entity-resolution adjudicator for Paylet, a fair-allocation ballot for limited product drops.
Every entry below is a DIFFERENT PayPal account that placed a hold. The rule is one unit per person/household/operation.
Decide which entries are controlled by the same household or the same reseller operation.

Guidelines:
- Same street address AND same unit/suite (after normalisation) => same place. Different names at one freight-forwarder suite => "same_operator".
- People sharing a single-family home address (no unit) => "same_household".
- Neighbours in DIFFERENT apartment numbers of one building are DISTINCT unless another strong signal links them.
- Identical common names in different cities are DISTINCT.
- A shared mailbox_token means the same mailbox (aliases already normalised) => same person.
- c/o or "Attn" routing at a commercial address is typical of reshippers.
- Be conservative: if you are not reasonably sure, return "distinct". A false merge takes a real fan's chance away.
Return groups that partition the given member ids (singletons as "distinct"). Evidence must cite concrete fields (address, unit, name, mailbox_token, timing, care_of). Keep explanations to one sentence a fan would understand.`;

function mailboxToken(email: string): string {
  return email ? createHash("sha256").update(email).digest("hex").slice(0, 6) : "";
}

function view(p: Prepared) {
  return {
    id: p.id,
    name: p.raw.name,
    street: p.addr.street,
    unit: p.addr.unit || null,
    city: p.addr.city,
    state: p.addr.state,
    zip: p.addr.zip5,
    care_of: p.addr.careOf || null,
    mailbox_token: mailboxToken(p.email) || null,
    entered_via: p.raw.source ?? "human",
    entered_at: p.raw.ts ? new Date(p.raw.ts).toISOString() : null,
  };
}

export async function resolve(list: Identity[], opts: { useLlm: boolean } = { useLlm: true }): Promise<ResolveResult> {
  const prepared = prepare(list);
  const byId = new Map(prepared.map((p) => [p.id, p]));
  const pairs = allPairs(prepared);
  const certain = pairs.filter((p) => p.band === "link");
  const uncertain = pairs.filter((p) => p.band === "uncertain");

  const links: [string, string][] = certain.map((p) => [p.a, p.b]);
  const evidenceByPair = new Map<string, PairScore>(pairs.map((p) => [`${p.a}|${p.b}`, p]));
  const aiGroups: { ids: string[]; g: LlmGroup }[] = [];
  let llmCalls = 0;

  if (opts.useLlm && uncertain.length) {
    // Components over all non-trivial pairs, adjudicated one component at a time (max 12 members per call).
    const comps = components(
      prepared.map((p) => p.id),
      [...certain, ...uncertain].map((p) => [p.a, p.b] as [string, string]),
    ).filter((c) => c.some((id) => uncertain.some((u) => u.a === id || u.b === id)));

    for (const comp of comps) {
      for (let i = 0; i < comp.length; i += 12) {
        const chunk = comp.slice(i, i + 12);
        const signals = pairs
          .filter((p) => chunk.includes(p.a) && chunk.includes(p.b))
          .map((p) => ({ a: p.a, b: p.b, rule_score: p.score, signals: p.signals.map((s) => s.detail) }));
        const res = await chatJson<{ groups: LlmGroup[] }>(
          "er_adjudicate",
          [
            { role: "system", content: SYSTEM },
            { role: "user", content: JSON.stringify({ entries: chunk.map((id) => view(byId.get(id)!)), deterministic_signals: signals }) },
          ],
          "er_groups",
          LLM_SCHEMA,
        );
        llmCalls++;
        for (const g of res.groups ?? []) {
          const ids = g.member_ids.filter((id) => chunk.includes(id));
          if (ids.length < 2 || g.verdict === "distinct" || g.confidence < 0.6) continue;
          aiGroups.push({ ids, g });
          for (let k = 1; k < ids.length; k++) links.push([ids[0], ids[k]]);
        }
      }
    }
  }

  const finalGroups = components(
    prepared.map((p) => p.id),
    links,
  );
  const clusters: ResolvedCluster[] = finalGroups.map((ids) => {
    const ai = aiGroups.find((x) => x.ids.some((id) => ids.includes(id)));
    const ruleEvidence = pairs
      .filter((p) => ids.includes(p.a) && ids.includes(p.b))
      .flatMap((p) => p.signals.map((s) => ({ field: s.field, detail: s.detail })));
    const dedup = [...new Map([...(ai?.g.evidence ?? []), ...ruleEvidence].map((e) => [`${e.field}:${e.detail}`, e])).values()].slice(0, 6);
    const operatorish =
      ai?.g.verdict === "same_operator" ||
      ids.some((id) => byId.get(id)?.addr.careOf) ||
      new Set(ids.map((id) => byId.get(id)!.name.at(-1))).size > 1;
    const certainOnly = ids.every((id) => certain.some((c) => c.a === id || c.b === id)) && !ai;
    const conf = ai
      ? Math.round(ai.g.confidence * 100) / 100
      : Math.max(...pairs.filter((p) => ids.includes(p.a) && ids.includes(p.b)).map((p) => p.score));
    return {
      memberIds: ids,
      kind: operatorish ? "operator" : "household",
      method: certainOnly ? "rules" : "ai",
      confidence: conf,
      evidence: dedup,
      explanation:
        ai?.g.explanation ??
        (operatorish
          ? `These ${ids.length} PayPal accounts ship to the same normalised address and unit.`
          : `These ${ids.length} PayPal accounts share one household address.`),
    };
  });
  void evidenceByPair;
  return { clusters, links, llmCalls, uncertainPairs: uncertain.length };
}
