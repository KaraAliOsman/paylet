// Runs the entity-resolution evals on the frozen dataset and writes evals/results.json + docs/EVALS.md.
// Systems: (1) exact match, (2) normalisation + rules (no LLM), (3) Paylet = rules + LLM adjudication of fuzzy pairs.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { env } from "../src/server/env";
import { exactBaseline, rulesBaseline } from "../src/server/er/rules";
import { resolve } from "../src/server/er/resolve";
import type { LabeledIdentity } from "../src/server/simulate";

const raw = readFileSync("evals/dataset.json", "utf8");
const meta = JSON.parse(readFileSync("evals/dataset.meta.json", "utf8"));
const sha = createHash("sha256").update(raw).digest("hex");
if (sha !== meta.sha256) throw new Error("dataset hash mismatch — the eval set is frozen; rebuild meta deliberately");
const data = JSON.parse(raw) as LabeledIdentity[];
const groupOf = new Map(data.map((d) => [d.id, d.group]));
const kindOf = new Map(data.map((d) => [d.id, d.kind]));

const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const truth = new Set<string>();
for (let i = 0; i < data.length; i++) for (let j = i + 1; j < data.length; j++) if (data[i].group === data[j].group) truth.add(key(data[i].id, data[j].id));

/** Expand links to the transitive closure (what an allocation system would actually do). */
function closure(links: [string, string][]): Set<string> {
  const parent = new Map(data.map((d) => [d.id, d.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  for (const [a, b] of links) parent.set(find(a), find(b));
  const groups = new Map<string, string[]>();
  for (const d of data) groups.set(find(d.id), [...(groups.get(find(d.id)) ?? []), d.id]);
  const out = new Set<string>();
  for (const g of groups.values()) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) out.add(key(g[i], g[j]));
  return out;
}

function score(system: string, predicted: Set<string>, llmCalls: number, ms: number) {
  let tp = 0;
  for (const p of predicted) if (truth.has(p)) tp++;
  const fp = predicted.size - tp;
  const fn = truth.size - tp;
  const precision = predicted.size ? tp / predicted.size : 1;
  const recall = truth.size ? tp / truth.size : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  // recall per ground-truth kind
  const byKind: Record<string, number> = {};
  for (const kind of ["reshipper_network", "household"]) {
    const pairs = [...truth].filter((t) => kindOf.get(t.split("|")[0]) === kind);
    byKind[kind] = pairs.length ? pairs.filter((p) => predicted.has(p)).length / pairs.length : 1;
  }
  const falseMergeKinds: Record<string, number> = {};
  for (const p of predicted) if (!truth.has(p)) for (const id of p.split("|")) falseMergeKinds[kindOf.get(id)!] = (falseMergeKinds[kindOf.get(id)!] ?? 0) + 1;
  return { system, precision, recall, f1, falseMerges: fp, missedLinks: fn, llmCalls, ms, recallByKind: byKind, falseMergeKinds };
}

const results = [];
let t = Date.now();
results.push(score("Exact match (raw address / email)", closure(exactBaseline(data)), 0, Date.now() - t));
t = Date.now();
results.push(score("Normalisation + rules (no AI)", closure(rulesBaseline(data, 0.6)), 0, Date.now() - t));
t = Date.now();
const paylet = await resolve(data, { useLlm: true });
results.push(score(`Paylet: rules + AI adjudication (${env.AI_MODEL.split("/").pop()})`, closure(paylet.links), paylet.llmCalls, Date.now() - t));

const out = {
  ranAt: new Date().toISOString(),
  model: env.AI_MODEL,
  dataset: { ...meta, sha256: sha },
  truthPairs: truth.size,
  uncertainPairs: paylet.uncertainPairs,
  results,
  notes: [
    `Ground truth: ${truth.size} account pairs that belong to the same household or reseller operation.`,
    `Only ${paylet.uncertainPairs} fuzzy pairs (out of ${(data.length * (data.length - 1)) / 2}) were sent to the model; everything else is decided by deterministic rules.`,
    "Hard negatives include neighbours in different apartments of one building and identical common names in different cities.",
    "In production nothing is auto-merged: these suggestions go to the seller, and fans can appeal.",
  ],
};
mkdirSync("evals", { recursive: true });
writeFileSync("evals/results.json", JSON.stringify(out, null, 2));

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const md = `# Entity-resolution evals

Frozen dataset: \`evals/dataset.json\` — ${meta.entries} entries (each a different PayPal account) in ${meta.groups} true people/operations.
SHA-256 \`${sha}\`. Generator: ${meta.generator}.

| System | Precision | Recall | F1 | False merges | Missed links | Network recall | Household recall | LLM calls | Time |
|---|---|---|---|---|---|---|---|---|---|
${results
  .map(
    (r) =>
      `| ${r.system} | ${pct(r.precision)} | ${pct(r.recall)} | **${pct(r.f1)}** | ${r.falseMerges} | ${r.missedLinks} | ${pct(r.recallByKind.reshipper_network)} | ${pct(r.recallByKind.household)} | ${r.llmCalls} | ${(r.ms / 1000).toFixed(1)}s |`,
  )
  .join("\n")}

${out.notes.map((n) => `- ${n}`).join("\n")}

Run on ${out.ranAt} with \`${env.AI_MODEL}\`. Reproduce with \`pnpm evals\` (needs an OpenAI-compatible key in \`.env\`).
Metrics are pairwise over the transitive closure (what an allocation system would actually merge).
`;
mkdirSync("docs", { recursive: true });
writeFileSync("docs/EVALS.md", md);
console.log(md);
