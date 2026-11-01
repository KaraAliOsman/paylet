// Eval harness for entity resolution: pairwise scoring over the transitive closure, failure attribution,
// and a cassette that records every model answer so anyone can replay the published numbers without a key.
// No env, db or network imports here: replay must run on a clean checkout.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { LabeledIdentity } from "../simulate";
import { allPairs, exactBaseline, prepare, rulesBaseline, type PairScore } from "./rules";
import { resolve, SYSTEM, type AdjudicationRequest, type Adjudicator, type ResolveResult } from "./resolve";

/** The frozen "system": normalisation + rules + the adjudication prompt and logic. */
export const SYSTEM_FILES = ["src/server/er/normalize.ts", "src/server/er/rules.ts", "src/server/er/resolve.ts"];

/** Line endings normalised to LF, so hashes match whatever git's autocrlf did to the checkout. */
export const lf = (s: string) => s.replace(/\r\n/g, "\n");

export function systemSha(root = "."): string {
  const h = createHash("sha256");
  for (const f of SYSTEM_FILES) h.update(`${f}\n`).update(lf(readFileSync(`${root}/${f}`, "utf8")));
  return h.digest("hex");
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function truthOf(data: LabeledIdentity[]): Set<string> {
  const truth = new Set<string>();
  for (let i = 0; i < data.length; i++) for (let j = i + 1; j < data.length; j++) if (data[i].group === data[j].group) truth.add(pairKey(data[i].id, data[j].id));
  return truth;
}

/** Expand links to the transitive closure (what an allocation system would actually merge). */
export function closure(data: LabeledIdentity[], links: [string, string][]): Set<string> {
  const parent = new Map(data.map((d) => [d.id, d.id]));
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  for (const [a, b] of links) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const d of data) groups.set(find(d.id), [...(groups.get(find(d.id)) ?? []), d.id]);
  const out = new Set<string>();
  for (const g of groups.values()) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) out.add(pairKey(g[i], g[j]));
  return out;
}

export interface Metrics {
  precision: number;
  recall: number;
  f1: number;
  falseMerges: number;
  missedLinks: number;
  recallByKind: Record<string, number>;
  falseMergeKinds: Record<string, number>;
}

export function score(data: LabeledIdentity[], truth: Set<string>, predicted: Set<string>): Metrics & { falsePairs: string[]; missedPairs: string[] } {
  const kindOf = new Map(data.map((d) => [d.id, d.kind]));
  const falsePairs = [...predicted].filter((p) => !truth.has(p));
  const missedPairs = [...truth].filter((t) => !predicted.has(t));
  const tp = predicted.size - falsePairs.length;
  const precision = predicted.size ? tp / predicted.size : 1;
  const recall = truth.size ? tp / truth.size : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const recallByKind: Record<string, number> = {};
  for (const kind of ["reshipper_network", "household"]) {
    const pairs = [...truth].filter((t) => kindOf.get(t.split("|")[0]) === kind);
    recallByKind[kind] = pairs.length ? pairs.filter((p) => predicted.has(p)).length / pairs.length : 1;
  }
  const falseMergeKinds: Record<string, number> = {};
  for (const p of falsePairs) for (const id of p.split("|")) falseMergeKinds[kindOf.get(id)!] = (falseMergeKinds[kindOf.get(id)!] ?? 0) + 1;
  return { precision, recall, f1, falseMerges: falsePairs.length, missedLinks: missedPairs.length, recallByKind, falseMergeKinds, falsePairs, missedPairs };
}

export interface Stat {
  mean: number;
  sd: number;
  min: number;
  max: number;
}
/** Mean, sample standard deviation, min and max. */
export function stat(xs: number[]): Stat {
  const n = xs.length;
  const mean = n ? xs.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { mean, sd, min: n ? Math.min(...xs) : 0, max: n ? Math.max(...xs) : 0 };
}

export function baselines(data: LabeledIdentity[], truth: Set<string>) {
  let t = Date.now();
  const exact = score(data, truth, closure(data, exactBaseline(data)));
  const exactMs = Date.now() - t;
  t = Date.now();
  const rules = score(data, truth, closure(data, rulesBaseline(data, 0.6)));
  const rulesMs = Date.now() - t;
  return { exact: { ...exact, ms: exactMs }, rules: { ...rules, ms: rulesMs } };
}

// ---------------------------------------------------------------- cassette

export interface CassetteCall {
  key: string;
  ok: boolean;
  response?: unknown;
  error?: string;
  ms: number;
}
export interface CassetteRun {
  /** Section label: "dev", "heldOut", or a later labelled variant such as "heldOutAfterFix". */
  dataset: string;
  run: number;
  ms: number;
  calls: CassetteCall[];
  /** Set on runs appended after the first recording. */
  recordedAt?: string;
  systemSha?: string;
}

/** Request keys whose every attempt failed in this run (the chunk the model never answered). */
export function failedKeys(run: CassetteRun): Set<string> {
  const ok = new Set(run.calls.filter((c) => c.ok).map((c) => c.key));
  return new Set(run.calls.filter((c) => !c.ok && !ok.has(c.key)).map((c) => c.key));
}
export interface Cassette {
  version: 1;
  model: string;
  recordedAt: string;
  systemSha: string;
  /** The adjudication system prompt, stored once. */
  system: string;
  /** What the model saw for each request key (the user message), stored once across runs. */
  requests: Record<string, string>;
  /** sha256 of each dataset file the runs were recorded against. */
  datasets: Record<string, string>;
  runs: CassetteRun[];
}

export const requestKey = (req: AdjudicationRequest) => sha256(`${req.system}\n${req.user}`).slice(0, 24);

/** Wraps a live adjudicator and records each answer (or error) into `run`. */
export function recorder(inner: Adjudicator, run: CassetteRun, requests: Record<string, string>): Adjudicator {
  return async (req) => {
    const key = requestKey(req);
    requests[key] = req.user;
    const t0 = Date.now();
    try {
      const response = await inner(req);
      run.calls.push({ key, ok: true, response, ms: Date.now() - t0 });
      return response;
    } catch (e) {
      const error = e instanceof Error ? `${e.constructor?.name ?? "Error"}: ${e.message}` : String(e);
      run.calls.push({ key, ok: false, error: error.slice(0, 300), ms: Date.now() - t0 });
      throw e;
    }
  };
}

/** Same class name as ai.ts, so resolve() treats a replayed budget stop exactly like the live one. */
class BudgetExceeded extends Error {}

/** Serves the recorded answers in order; any request the cassette does not know is a miss. */
export function replayer(run: CassetteRun): { adjudicator: Adjudicator; misses: string[] } {
  const queue = new Map<string, CassetteCall[]>();
  for (const c of run.calls) queue.set(c.key, [...(queue.get(c.key) ?? []), c]);
  const misses: string[] = [];
  const adjudicator: Adjudicator = async (req) => {
    const key = requestKey(req);
    const next = queue.get(key)?.shift();
    if (!next) {
      misses.push(key);
      throw new Error(`cassette miss ${key}`);
    }
    if (!next.ok) {
      const [name, ...rest] = (next.error ?? "Error: recorded failure").split(": ");
      const message = rest.join(": ") || name;
      throw name === "BudgetExceeded" ? new BudgetExceeded(message) : new Error(message);
    }
    return next.response;
  };
  return { adjudicator, misses };
}

// ---------------------------------------------------------------- one evaluated model run

export interface RunOutcome {
  metrics: ReturnType<typeof score>;
  result: ResolveResult;
  llmCalls: number;
  ms: number;
}

export async function runPaylet(data: LabeledIdentity[], truth: Set<string>, adjudicator: Adjudicator): Promise<RunOutcome> {
  const t = Date.now();
  const result = await resolve(data, { useLlm: true, adjudicator });
  const ms = Date.now() - t;
  return { metrics: score(data, truth, closure(data, result.links)), result, llmCalls: result.llmCalls, ms };
}

// ---------------------------------------------------------------- failure attribution

export interface Bridge {
  a: string;
  b: string;
  by: "rules" | "ai";
  ruleScore: number;
  signals: string[];
  explanation: string | null;
  confidence: number | null;
}

/**
 * For a false merge, the direct links that joined two different true groups ("bridges"). Fixing a bridge removes
 * every false pair it created through the transitive closure.
 */
export function bridges(data: LabeledIdentity[], result: ResolveResult): Bridge[] {
  const groupOf = new Map(data.map((d) => [d.id, d.group]));
  const pairs = new Map<string, PairScore>(allPairs(prepare(data)).map((p) => [pairKey(p.a, p.b), p]));
  const out = new Map<string, Bridge>();
  for (const [a, b] of result.links) {
    if (groupOf.get(a) === groupOf.get(b)) continue;
    const k = pairKey(a, b);
    if (out.has(k)) continue;
    const p = pairs.get(k);
    const byRules = p?.band === "link";
    const cluster = result.clusters.find((c) => c.memberIds.includes(a) && c.memberIds.includes(b));
    out.set(k, {
      a: k.split("|")[0],
      b: k.split("|")[1],
      by: byRules ? "rules" : "ai",
      ruleScore: p?.score ?? 0,
      signals: p?.signals.map((s) => s.detail) ?? [],
      explanation: byRules ? null : (cluster?.explanation ?? null),
      confidence: byRules ? (p?.score ?? null) : (cluster?.confidence ?? null),
    });
  }
  return [...out.values()];
}

export { SYSTEM };
