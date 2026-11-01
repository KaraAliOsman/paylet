// Entity-resolution evals → evals/results.json + docs/EVALS.md (+ evals/cassette.json when live).
//
//   pnpm evals                     live: 3 model runs per dataset, records every answer in evals/cassette.json
//   pnpm evals --replay            offline: no env, no key, no network; replays the cassette and checks that it
//                                  reproduces the published evals/results.json exactly (exit 1 if not)
//   pnpm evals --replay --write    same, then rewrites results.json + EVALS.md from the cassette
//                                  (used after adding failure analysis in evals/failure-notes.json)
//   options: --runs N (live, default 3) · --only dev|heldOut · --no-write (live smoke test)
//
// Systems: (1) exact match, (2) normalisation + rules (no LLM), (3) Paylet = rules + LLM adjudication of fuzzy pairs.
// Datasets: dev (the set the rules and prompt were tuned on) and heldOut (generated after the system was frozen).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  baselines,
  lf,
  bridges,
  pairKey,
  recorder,
  replayer,
  runPaylet,
  sha256,
  stat,
  SYSTEM,
  SYSTEM_FILES,
  systemSha,
  truthOf,
  type Cassette,
  type CassetteRun,
  type Metrics,
  type RunOutcome,
  type Stat,
} from "../src/server/er/evaluate";
import { llmAdjudicator } from "../src/server/er/resolve";
import type { LabeledIdentity } from "../src/server/simulate";

const args = process.argv.slice(2);
const REPLAY = args.includes("--replay");
const WRITE = !args.includes("--no-write") && (!REPLAY || args.includes("--write"));
const argVal = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const ONLY = argVal("--only");
const CASSETTE_FILE = "evals/cassette.json";
const RESULTS_FILE = "evals/results.json";
const NOTES_FILE = "evals/failure-notes.json";

type DatasetName = "dev" | "heldOut";
const SPECS: { name: DatasetName; file: string; metaFile: string }[] = [
  { name: "dev", file: "evals/dataset.json", metaFile: "evals/dataset.meta.json" },
  { name: "heldOut", file: "evals/heldout.json", metaFile: "evals/heldout.meta.json" },
];

// ---------------------------------------------------------------- inputs

const cassette: Cassette = REPLAY
  ? (JSON.parse(readFileSync(CASSETTE_FILE, "utf8")) as Cassette)
  : { version: 1, model: "", recordedAt: new Date().toISOString(), systemSha: systemSha(), system: SYSTEM, requests: {}, datasets: {}, runs: [] };
const RUNS = REPLAY ? Math.max(...cassette.runs.map((r) => r.run)) : Number(argVal("--runs") ?? 3);
const model = REPLAY ? cassette.model : (await import("../src/server/env")).env.AI_MODEL;
cassette.model = model;
const modelShort = model.split("/").pop()!;
const currentSystem = systemSha();
if (REPLAY && cassette.systemSha !== currentSystem) {
  console.warn(`! system files changed since the cassette was recorded (${cassette.systemSha.slice(0, 12)} → ${currentSystem.slice(0, 12)}); replay may miss.`);
}
const failureNotes: Record<string, string> = existsSync(NOTES_FILE) ? JSON.parse(readFileSync(NOTES_FILE, "utf8")) : {};

function load(spec: (typeof SPECS)[number]) {
  const raw = readFileSync(spec.file, "utf8");
  const meta = JSON.parse(readFileSync(spec.metaFile, "utf8"));
  const sha = sha256(lf(raw)); // git may check JSON out with CRLF on Windows; the frozen hash is over LF
  if (sha !== meta.sha256) throw new Error(`${spec.file}: hash mismatch — eval sets are frozen; rebuild meta deliberately`);
  if (REPLAY && cassette.datasets[spec.name] && cassette.datasets[spec.name] !== sha) throw new Error(`${spec.file} is not the dataset the cassette was recorded on`);
  return { raw, meta, sha, data: JSON.parse(raw) as LabeledIdentity[] };
}

// ---------------------------------------------------------------- evaluate one dataset

interface RunRow {
  run: number;
  precision: number;
  recall: number;
  f1: number;
  falseMerges: number;
  missedLinks: number;
  llmCalls: number;
  ms: number;
  keptApart: number;
  degraded: string | null;
}
type Row = Omit<Metrics, never> & {
  id: "exact" | "rules" | "paylet";
  system: string;
  llmCalls: number;
  ms: number;
  runs?: RunRow[];
  stats?: Record<"precision" | "recall" | "f1" | "falseMerges" | "missedLinks", Stat>;
  worstRun?: number;
};

interface ExampleEntry {
  id: string;
  name: string;
  address: string;
  source: string;
  origin: string;
  note?: string;
}
interface Failure {
  kind: "false_merge" | "missed_link";
  dataset: DatasetName;
  key: string;
  runs: string;
  runCount: number;
  decidedBy: "rules" | "ai" | "none";
  pairsAffected: number;
  entries: ExampleEntry[];
  detail: string;
  analysis: string | null;
}

const misses: string[] = [];
let totalCalls = 0;

async function evaluate(spec: (typeof SPECS)[number]) {
  const { meta, sha, data } = load(spec);
  cassette.datasets[spec.name] = sha;
  const truth = truthOf(data);
  const base = baselines(data, truth);
  const outs: RunOutcome[] = [];
  for (let i = 1; i <= RUNS; i++) {
    let o: RunOutcome;
    if (REPLAY) {
      const run = cassette.runs.find((r) => r.dataset === spec.name && r.run === i);
      if (!run) throw new Error(`cassette has no ${spec.name} run ${i}`);
      const rp = replayer(run);
      o = await runPaylet(data, truth, rp.adjudicator);
      o.ms = run.ms;
      misses.push(...rp.misses);
    } else {
      const run: CassetteRun = { dataset: spec.name, run: i, ms: 0, calls: [] };
      o = await runPaylet(data, truth, recorder(llmAdjudicator, run, cassette.requests));
      run.ms = o.ms;
      cassette.runs.push(run);
    }
    totalCalls += o.llmCalls;
    outs.push(o);
    const m = o.metrics;
    console.log(
      `[${spec.name}] run ${i}/${RUNS}: P ${pct(m.precision)} R ${pct(m.recall)} F1 ${pct(m.f1)} · false merges ${m.falseMerges} · missed ${m.missedLinks} · ${o.llmCalls} calls · ${(o.ms / 1000).toFixed(1)}s${o.result.degraded ? ` · DEGRADED: ${o.result.degraded}` : ""}`,
    );
  }

  const strip = <T extends { falsePairs: string[]; missedPairs: string[] }>({ falsePairs: _f, missedPairs: _m, ...rest }: T) => rest;
  const runs: RunRow[] = outs.map((o, i) => ({
    run: i + 1,
    precision: o.metrics.precision,
    recall: o.metrics.recall,
    f1: o.metrics.f1,
    falseMerges: o.metrics.falseMerges,
    missedLinks: o.metrics.missedLinks,
    llmCalls: o.llmCalls,
    ms: o.ms,
    keptApart: o.result.keptApart.length,
    degraded: o.result.degraded,
  }));
  const worst = outs.reduce((w, o, i) => (o.metrics.f1 < outs[w].metrics.f1 ? i : w), 0);
  const s = (k: "precision" | "recall" | "f1" | "falseMerges" | "missedLinks") => stat(outs.map((o) => o.metrics[k]));
  const stats = { precision: s("precision"), recall: s("recall"), f1: s("f1"), falseMerges: s("falseMerges"), missedLinks: s("missedLinks") };
  const results: Row[] = [
    { id: "exact", system: "Exact match (raw address / email)", ...strip(base.exact), llmCalls: 0 },
    { id: "rules", system: "Normalisation + rules (no AI)", ...strip(base.rules), llmCalls: 0 },
    {
      id: "paylet",
      system: `Paylet: rules + AI adjudication (${modelShort})`,
      precision: stats.precision.mean,
      recall: stats.recall.mean,
      f1: stats.f1.mean,
      falseMerges: stats.falseMerges.mean,
      missedLinks: stats.missedLinks.mean,
      llmCalls: stat(outs.map((o) => o.llmCalls)).mean,
      ms: stat(outs.map((o) => o.ms)).mean,
      recallByKind: outs[worst].metrics.recallByKind,
      falseMergeKinds: outs[worst].metrics.falseMergeKinds,
      runs,
      stats,
      worstRun: worst + 1,
    },
  ];

  return {
    spec,
    data,
    outs,
    section: {
      dataset: { ...meta, sha256: sha },
      truthPairs: truth.size,
      uncertainPairs: outs[0]?.result.uncertainPairs ?? 0,
      totalPairs: (data.length * (data.length - 1)) / 2,
      results,
    },
    failures: failures(spec.name, data, outs),
  };
}

// ---------------------------------------------------------------- examples and failures

function entryOf(d: LabeledIdentity): ExampleEntry {
  const a = d.address;
  return {
    id: d.label ?? d.id,
    name: d.name,
    address: [a.line1, a.line2, a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    source: d.source ?? "human",
    origin: d.origin ?? "generated",
    ...(d.note ? { note: d.note } : {}),
  };
}

function failures(dataset: DatasetName, data: LabeledIdentity[], outs: RunOutcome[]): Failure[] {
  const byId = new Map(data.map((d) => [d.id, d]));
  const found = new Map<string, Failure & { seen: Set<number> }>();
  outs.forEach((o, run) => {
    for (const b of bridges(data, o.result)) {
      const ga = byId.get(b.a)!.group;
      const gb = byId.get(b.b)!.group;
      const affected = o.metrics.falsePairs.filter((p) => {
        const [x, y] = p.split("|").map((id) => byId.get(id)!.group);
        return (x === ga && y === gb) || (x === gb && y === ga);
      }).length;
      const key = pairKey(b.a, b.b);
      const f = found.get(key) ?? {
        kind: "false_merge" as const,
        dataset,
        key,
        runs: "",
        runCount: 0,
        decidedBy: b.by,
        pairsAffected: affected,
        entries: [byId.get(b.a)!, byId.get(b.b)!].map(entryOf),
        detail:
          b.by === "rules"
            ? `Linked by the deterministic rules (score ${b.ruleScore}: ${b.signals.join("; ")}), so the model never reviewed it. The closure then merged two different true groups.`
            : `Linked by the model (${Math.round((b.confidence ?? 0) * 100)}%): "${b.explanation ?? ""}" Rule signals: ${b.signals.join("; ") || "none"}.`,
        analysis: failureNotes[key] ?? null,
        seen: new Set<number>(),
      };
      f.seen.add(run);
      found.set(key, f);
    }
    // missed links, grouped by the true group they belong to
    const missedByGroup = new Map<string, string[]>();
    for (const p of o.metrics.missedPairs) {
      const g = byId.get(p.split("|")[0])!.group;
      missedByGroup.set(g, [...(missedByGroup.get(g) ?? []), p]);
    }
    for (const [g, ps] of missedByGroup) {
      const key = `group:${g}`;
      const [a, b] = ps[0].split("|");
      const kept = o.result.keptApart.find((k) => pairKey(k.a, k.b) === pairKey(byId.get(a)!.label ?? a, byId.get(b)!.label ?? b));
      const members = data.filter((d) => d.group === g);
      const f = found.get(key) ?? {
        kind: "missed_link" as const,
        dataset,
        key,
        runs: "",
        runCount: 0,
        decidedBy: kept ? ("ai" as const) : ("none" as const),
        pairsAffected: ps.length,
        entries: members.map(entryOf),
        detail: kept
          ? `The model kept ${a} and ${b} apart (${Math.round(kept.confidence * 100)}%): "${kept.reason}"`
          : `${ps.length} true pair(s) never reached a link: the rule score stayed below the review threshold or the model left them unlinked.`,
        analysis: failureNotes[key] ?? null,
        seen: new Set<number>(),
      };
      f.seen.add(run);
      found.set(key, f);
    }
  });
  return [...found.values()]
    .map(({ seen, ...f }) => ({ ...f, runCount: seen.size, runs: `${seen.size}/${outs.length} runs` }))
    .sort((x, y) => y.runCount - x.runCount || (x.kind === "false_merge" ? -1 : 1) || y.pairsAffected - x.pairsAffected);
}

function examples(ev: Evaluated) {
  const { data, outs } = ev;
  const byId = new Map(data.map((d) => [d.id, d]));
  const out: Record<string, unknown>[] = [];
  const o = outs[0];
  const sameGroup = (ids: string[]) => new Set(ids.map((id) => byId.get(id)!.group)).size === 1;
  const linkedInRuns = (ids: string[]) =>
    outs.filter((x) => {
      const c = x.result.clusters.find((cl) => cl.memberIds.includes(ids[0]));
      return c && ids.every((id) => c.memberIds.includes(id));
    }).length;

  const linked = o.result.clusters
    .filter((c) => c.method === "ai" && sameGroup(c.memberIds))
    .sort((x, y) => {
      const rt = (c: typeof x) => c.memberIds.filter((id) => byId.get(id)!.origin === "redteam").length;
      return rt(y) - rt(x) || y.memberIds.length - x.memberIds.length;
    })[0];
  if (linked) {
    out.push({
      type: "linked",
      dataset: ev.spec.name,
      title: `${linked.memberIds.length} PayPal accounts, one ${linked.kind === "operator" ? "reseller operation" : "household"}`,
      entries: linked.memberIds.map((id) => entryOf(byId.get(id)!)),
      decidedBy: "ai",
      verdict: `Linked as one ${linked.kind === "operator" ? "operator" : "household"}`,
      confidence: linked.confidence,
      reason: linked.explanation,
      evidence: linked.evidence,
      truth: "same",
      correct: true,
      runsObserved: `${linkedInRuns(linked.memberIds)}/${outs.length} runs`,
    });
  }

  const labelToId = new Map(data.map((d) => [d.label ?? d.id, d.id]));
  const kept = o.result.keptApart
    .map((k) => ({ k, a: byId.get(labelToId.get(k.a)!)!, b: byId.get(labelToId.get(k.b)!)! }))
    .filter((x) => x.a.group !== x.b.group)
    .sort((x, y) => Number(y.a.origin === "handwritten" || y.b.origin === "handwritten") - Number(x.a.origin === "handwritten" || x.b.origin === "handwritten"))[0];
  if (kept) {
    const keptIn = outs.filter((x) => x.result.keptApart.some((k) => pairKey(k.a, k.b) === pairKey(kept.k.a, kept.k.b))).length;
    out.push({
      type: "kept_apart",
      dataset: ev.spec.name,
      title: kept.a.note ?? kept.b.note ?? "Looked alike to the rules, kept apart by the model",
      entries: [entryOf(kept.a), entryOf(kept.b)],
      decidedBy: "ai",
      verdict: "Kept apart",
      confidence: kept.k.confidence,
      reason: kept.k.reason,
      truth: "different",
      correct: true,
      runsObserved: `${keptIn}/${outs.length} runs`,
    });
  }

  const f = ev.failures[0];
  if (f) {
    out.push({
      type: "failure",
      dataset: ev.spec.name,
      title: f.kind === "false_merge" ? `False merge (${f.pairsAffected} pair${f.pairsAffected === 1 ? "" : "s"})` : `Missed link (${f.pairsAffected} pair${f.pairsAffected === 1 ? "" : "s"})`,
      entries: f.entries,
      decidedBy: f.decidedBy,
      verdict: f.kind === "false_merge" ? "Merged, but they are different people" : "Left apart, but they are the same household/operation",
      confidence: null,
      reason: f.detail,
      truth: f.kind === "false_merge" ? "different" : "same",
      correct: false,
      runsObserved: f.runs,
      analysis: f.analysis,
    });
  }
  return out;
}

// ---------------------------------------------------------------- run

const evaluated: Evaluated[] = [];
for (const spec of SPECS) {
  if (ONLY && spec.name !== ONLY) continue;
  if (!existsSync(spec.file)) {
    console.warn(`(skipping ${spec.name}: ${spec.file} not found)`);
    continue;
  }
  evaluated.push(await evaluate(spec));
}
type Evaluated = Awaited<ReturnType<typeof evaluate>>;
const devOrNull = evaluated.find((e) => e.spec.name === "dev");
const held = evaluated.find((e) => e.spec.name === "heldOut");
if (!devOrNull) throw new Error("the dev set is required");
const dev: Evaluated = devOrNull;

const paylet = (e: Evaluated) => e.section.results.find((r) => r.id === "paylet")!;
const rules = (e: Evaluated) => e.section.results.find((r) => r.id === "rules")!;
const exampleSource = held ?? dev;
const exampleList = [...examples(exampleSource)];
if (!exampleList.some((x) => x.type === "failure") && held && dev.failures[0]) exampleList.push(...examples(dev).filter((x) => x.type === "failure"));
const heldFailures = held?.failures ?? [];

const out = {
  schemaVersion: 2,
  ranAt: REPLAY ? cassette.recordedAt : new Date().toISOString(),
  ...(REPLAY ? { replayedAt: new Date().toISOString() } : {}),
  mode: REPLAY ? "replay" : "live",
  model,
  runs: RUNS,
  system: { sha256: cassette.systemSha, files: SYSTEM_FILES, unchangedSinceRecording: cassette.systemSha === currentSystem },
  cassette: { file: CASSETTE_FILE, calls: cassette.runs.reduce((n, r) => n + r.calls.length, 0) },
  // dev (tuning) set — same fields as schema v1
  ...dev.section,
  heldOut: held
    ? {
        ...held.section,
        frozenSystemSha: held.section.dataset.frozenSystemSha ?? null,
        systemUnchangedSinceFreeze: held.section.dataset.frozenSystemSha === cassette.systemSha,
        failures: heldFailures,
      }
    : null,
  headline: {
    falseMergesRulesDev: rules(dev).falseMerges,
    falseMergesPayletDev: paylet(dev).stats!.falseMerges,
    heldOut: held
      ? {
          precision: paylet(held).stats!.precision,
          recall: paylet(held).stats!.recall,
          f1: paylet(held).stats!.f1,
          falseMerges: paylet(held).stats!.falseMerges,
          missedLinks: paylet(held).stats!.missedLinks,
          falseMergesRules: rules(held).falseMerges,
          failures: heldFailures.length,
          failuresExplained: heldFailures.filter((f) => f.analysis).length,
        }
      : null,
  },
  examples: exampleList,
  notes: [
    `Dev set: ${dev.section.truthPairs} true pairs; only ${dev.section.uncertainPairs} fuzzy pairs (of ${dev.section.totalPairs}) go to the model, everything else is decided by deterministic rules.`,
    held
      ? `Held-out set: generated after the rules and prompt were frozen (other seed, other red-team template, hand-written neighbours, namesakes and forwarder customers). ${held.section.truthPairs} true pairs, ${held.section.uncertainPairs} fuzzy pairs sent to the model.`
      : "No held-out set yet.",
    `Paylet numbers are the mean of ${RUNS} independent model runs (± sample standard deviation); the worst run is published too.`,
    "Every model answer is recorded in evals/cassette.json: `pnpm evals --replay` reproduces these numbers offline, without a key.",
    "In production nothing is auto-merged: these suggestions go to the seller, and fans can appeal.",
  ],
};

// ---------------------------------------------------------------- replay check / write

const metricKeys = ["precision", "recall", "f1", "falseMerges", "missedLinks"] as const;
let mismatch = false;
if (REPLAY) {
  if (misses.length) {
    console.error(`✗ ${misses.length} model request(s) are not in the cassette: the prompt or the rules changed since recording. Re-record with a live run.`);
    mismatch = true;
  }
  const published = existsSync(RESULTS_FILE) ? JSON.parse(readFileSync(RESULTS_FILE, "utf8")) : null;
  for (const e of evaluated) {
    const pub = e.spec.name === "dev" ? published : published?.heldOut;
    for (const row of e.section.results) {
      const p = pub?.results?.find((r: { id?: string }) => r.id === row.id);
      for (const k of metricKeys) {
        if (!p || Math.abs(p[k] - row[k]) > 1e-9) {
          console.error(`✗ ${e.spec.name} / ${row.id} / ${k}: published ${p?.[k]} vs replayed ${row[k]}`);
          mismatch = true;
        }
      }
    }
  }
  if (!mismatch) console.log(`✓ replay reproduces the published results (${totalCalls} recorded model answers, no network).`);
}

if (WRITE && !(REPLAY && misses.length)) {
  mkdirSync("evals", { recursive: true });
  writeFileSync(RESULTS_FILE, `${JSON.stringify(out, null, 2)}\n`);
  if (!REPLAY) writeFileSync(CASSETTE_FILE, `${JSON.stringify(cassette, null, 1)}\n`);
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/EVALS.md", markdown());
  console.log(`wrote ${RESULTS_FILE}${REPLAY ? "" : `, ${CASSETTE_FILE}`} and docs/EVALS.md`);
}
if (mismatch && !WRITE) process.exitCode = 1;

// ---------------------------------------------------------------- markdown

function pct(x: number) {
  return `${(x * 100).toFixed(1)}%`;
}
function pctStat(s: Stat) {
  return `${pct(s.mean)} ± ${(s.sd * 100).toFixed(1)}`;
}
function numStat(s: Stat) {
  return `${s.mean.toFixed(1)} ± ${s.sd.toFixed(1)}`;
}

function table(e: Evaluated) {
  const rows = e.section.results.map((r) => {
    if (r.stats) {
      return `| **${r.system}** — mean of ${r.runs!.length} runs | ${pctStat(r.stats.precision)} | ${pctStat(r.stats.recall)} | **${pctStat(r.stats.f1)}** | ${numStat(r.stats.falseMerges)} (worst ${r.stats.falseMerges.max}) | ${numStat(r.stats.missedLinks)} (worst ${r.stats.missedLinks.max}) | ${pct(r.recallByKind.reshipper_network)} | ${pct(r.recallByKind.household)} | ${r.llmCalls.toFixed(0)} | ${(r.ms / 1000).toFixed(1)}s |`;
    }
    return `| ${r.system} | ${pct(r.precision)} | ${pct(r.recall)} | ${pct(r.f1)} | ${r.falseMerges} | ${r.missedLinks} | ${pct(r.recallByKind.reshipper_network)} | ${pct(r.recallByKind.household)} | 0 | ${(r.ms / 1000).toFixed(1)}s |`;
  });
  const p = paylet(e);
  const perRun = p.runs!.map((r) => `| ${r.run}${r.run === p.worstRun ? " (worst)" : ""} | ${pct(r.precision)} | ${pct(r.recall)} | ${pct(r.f1)} | ${r.falseMerges} | ${r.missedLinks} | ${r.keptApart} | ${r.llmCalls} | ${r.degraded ?? "—"} |`);
  return `| System | Precision | Recall | F1 | False merges | Missed links | Network recall | Household recall | LLM calls | Time |
|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}

Paylet, run by run (network/household recall above are from the worst run):

| Run | Precision | Recall | F1 | False merges | Missed links | Pairs kept apart | LLM calls | Degraded |
|---|---|---|---|---|---|---|---|---|
${perRun.join("\n")}`;
}

function entriesMd(entries: ExampleEntry[]) {
  return entries.map((x) => `  - \`${x.id}\` ${x.name} — ${x.address} (${x.source}${x.origin !== "generated" ? `, ${x.origin}` : ""})`).join("\n");
}

function markdown() {
  const h = out.headline.heldOut;
  const devP = paylet(dev);
  const fm = (s: Stat) => (s.max === 0 ? "0 in every run" : `${s.mean.toFixed(1)} on average, ${s.max} in the worst run`);
  const failMd = heldFailures.length
    ? heldFailures
        .map(
          (f) => `### ${f.kind === "false_merge" ? "False merge" : "Missed link"} · ${f.runs} · decided by ${f.decidedBy}
${entriesMd(f.entries)}

What happened: ${f.detail}

${f.analysis ? `Our analysis: ${f.analysis}` : "_Not analysed yet._"}`,
        )
        .join("\n\n")
    : "No held-out failures in any run.";
  const exMd = out.examples
    .map((x) => {
      const e = x as { type: string; title: string; entries: ExampleEntry[]; verdict: string; confidence: number | null; reason: string; runsObserved: string; dataset: string; analysis?: string | null };
      return `### ${e.type === "linked" ? "Linked" : e.type === "kept_apart" ? "Kept apart" : "Failure"}: ${e.title} (${e.dataset}, ${e.runsObserved})
${entriesMd(e.entries)}

${e.verdict}${e.confidence != null ? ` (${Math.round(e.confidence * 100)}%)` : ""}: ${e.reason}${e.analysis ? `\n\nOur analysis: ${e.analysis}` : ""}`;
    })
    .join("\n\n");

  return `# Entity-resolution evals

${
  h
    ? `**Held-out (never used for tuning): precision ${pctStat(h.precision)}, recall ${pctStat(h.recall)}, F1 ${pctStat(h.f1)} over ${RUNS} runs; false merges ${fm(h.falseMerges)}; ${h.failures} failure mode${h.failures === 1 ? "" : "s"}, ${h.failuresExplained} explained below.**`
    : "**No held-out set yet.**"
}
On the dev set the AI review takes rules-only false merges from **${rules(dev).falseMerges} → ${devP.stats!.falseMerges.mean.toFixed(1)}** (mean of ${RUNS} runs).

## \`evals/results.json\` shape (read by \`/evals\`)

\`\`\`ts
interface Stat { mean: number; sd: number; min: number; max: number }          // sd = sample standard deviation over runs
interface SystemResult {
  id: "exact" | "rules" | "paylet"; system: string;
  precision: number; recall: number; f1: number;                              // 0..1; for "paylet" = mean over runs
  falseMerges: number; missedLinks: number;                                   // pairs; for "paylet" = mean (may be fractional)
  llmCalls: number; ms: number;                                               // for "paylet" = mean per run
  recallByKind: { reshipper_network: number; household: number };            // for "paylet" = worst run
  falseMergeKinds: Record<string, number>;                                    // for "paylet" = worst run
  runs?: { run: number; precision: number; recall: number; f1: number; falseMerges: number; missedLinks: number;
           llmCalls: number; ms: number; keptApart: number; degraded: string | null }[];   // "paylet" only
  stats?: Record<"precision" | "recall" | "f1" | "falseMerges" | "missedLinks", Stat>; // "paylet" only
  worstRun?: number;                                                          // 1-based, lowest F1
}
interface DatasetSection {
  dataset: { sha256: string; entries: number; groups: number; kinds: Record<string, number>; generator: string; frozenAt: string;
             seed?: number; origins?: Record<string, number>; frozenSystemSha?: string };
  truthPairs: number; uncertainPairs: number; totalPairs: number; results: SystemResult[];
}
interface ExampleEntry { id: string; name: string; address: string; source: string; origin: "generated" | "redteam" | "handwritten"; note?: string }
interface Failure {
  kind: "false_merge" | "missed_link"; dataset: "dev" | "heldOut"; key: string; runs: string /* "3/3 runs" */; runCount: number;
  decidedBy: "rules" | "ai" | "none"; pairsAffected: number; entries: ExampleEntry[]; detail: string; analysis: string | null;
}
interface Example {
  type: "linked" | "kept_apart" | "failure"; dataset: "dev" | "heldOut"; title: string; entries: ExampleEntry[];
  decidedBy: "rules" | "ai" | "none"; verdict: string; confidence: number | null; reason: string;
  evidence?: { field: string; detail: string }[]; truth: "same" | "different"; correct: boolean; runsObserved: string;
  analysis?: string | null;
}
interface EvalResults extends DatasetSection {                                 // top level = dev set (schema v1 fields kept)
  schemaVersion: 2; ranAt: string; replayedAt?: string; mode: "live" | "replay"; model: string; runs: number;
  system: { sha256: string; files: string[]; unchangedSinceRecording: boolean };
  cassette: { file: string; calls: number };
  heldOut: (DatasetSection & { frozenSystemSha: string | null; systemUnchangedSinceFreeze: boolean; failures: Failure[] }) | null;
  headline: {
    falseMergesRulesDev: number; falseMergesPayletDev: Stat;                   // tile: "False merges 13 → 0"
    heldOut: { precision: Stat; recall: Stat; f1: Stat; falseMerges: Stat; missedLinks: Stat; falseMergesRules: number;
               failures: number; failuresExplained: number } | null;          // tile: "Held-out: P x% · R y% · 1 failure explained"
  };
  examples: Example[];                                                         // linked, kept_apart, failure (when there is one)
  notes: string[];
}
\`\`\`

## Protocol

1. **Dev set** — \`evals/dataset.json\` (${dev.section.dataset.entries} entries, ${dev.section.dataset.groups} true people/operations; SHA-256 \`${dev.section.dataset.sha256.slice(0, 16)}…\`). ${dev.section.dataset.generator}. The rules and the adjudication prompt were developed against this set, so its numbers are optimistic by construction.
2. **Held-out set** — ${
    held
      ? `\`evals/heldout.json\` (${held.section.dataset.entries} entries, ${held.section.dataset.groups} true groups; SHA-256 \`${held.section.dataset.sha256.slice(0, 16)}…\`), frozen ${held.section.dataset.frozenAt}. ${held.section.dataset.generator}. It was generated **after** the system files (${SYSTEM_FILES.map((f) => `\`${f}\``).join(", ")}) were frozen at SHA-256 \`${String(held.section.dataset.frozenSystemSha).slice(0, 16)}…\`; these results were produced with system \`${cassette.systemSha.slice(0, 16)}…\` (${out.heldOut!.systemUnchangedSinceFreeze ? "unchanged since the freeze" : "**changed since the freeze**"}). The hand-written cases were written by the same team that wrote the rules, so this is an adversarial test, not a blind one.`
      : "not generated yet."
  }
3. **${RUNS} runs** — the model (temperature 0.1) is called ${RUNS} independent times per dataset; we publish mean ± sample standard deviation and the worst run. The baselines are deterministic.
4. **Replay** — every model answer is stored in \`evals/cassette.json\` with the exact input it answered. \`pnpm evals --replay\` re-scores from the cassette with no key, no network and no app config, and fails if the numbers differ from \`evals/results.json\`.
5. Metrics are pairwise over the transitive closure (what an allocation system would actually merge). A **false merge** takes a real fan's chance away; a **missed link** lets an operation enter twice.

## Held-out set

${held ? table(held) : "_Not generated yet._"}

## Dev set

${table(dev)}

## Failures on the held-out set

${failMd}

## Examples

${exMd}

## Honest caveats

- Both datasets are synthetic and built by us; the generators, the red-team prompts and the hand-written cases are in the repo.
- Rules alone are already strong on recall. The model's job is to remove false merges (a false merge costs a real fan their chance) and to explain decisions, including why it kept look-alikes apart.
- When the AI is unavailable, Paylet degrades to rules-only suggestions and says so; nothing is ever auto-merged — the seller confirms every cluster.

Run ${out.ranAt}${"replayedAt" in out ? ` (replayed ${out.replayedAt})` : ""} with \`${model}\`. Reproduce live with \`pnpm evals\` (needs an OpenAI-compatible key) or offline with \`pnpm evals --replay\`.
`;
}
