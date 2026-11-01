// Entity-resolution evals → evals/results.json + docs/EVALS.md (+ evals/cassette.json when live).
//
//   pnpm evals                     live: 3 model runs on dev + held-out, records every answer in a NEW evals/cassette.json
//   pnpm evals --replay            offline: no env, no key, no network; replays the cassette and checks that it
//                                  reproduces the published evals/results.json exactly (exit 1 if not)
//   pnpm evals --replay --write    same, then rewrites results.json + EVALS.md from the cassette
//                                  (used after adding failure analysis in evals/failure-notes.json)
//   pnpm evals --append --only heldOutAfterFix
//                                  live runs for ONE labelled section, appended to the existing cassette; every other
//                                  section is replayed. Used to publish post-fix numbers next to the blind ones.
//   options: --runs N (live, default 3) · --only <section> · --no-write (live smoke test)
//
// Systems: (1) exact match, (2) normalisation + rules (no LLM), (3) Paylet = rules + LLM adjudication of fuzzy pairs.
// Sections: dev (the set the rules and prompt were tuned on), heldOut (generated after the system was frozen; blind),
// heldOutAfterFix (same held-out file, re-run after a labelled fix — not blind).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  baselines,
  bridges,
  failedKeys,
  lf,
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
import { allPairs, prepare } from "../src/server/er/rules";
import { llmAdjudicator } from "../src/server/er/resolve";
import type { LabeledIdentity } from "../src/server/simulate";

const args = process.argv.slice(2);
const REPLAY = args.includes("--replay");
const APPEND = args.includes("--append");
const WRITE = !args.includes("--no-write") && (!REPLAY || args.includes("--write"));
const argVal = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const ONLY = argVal("--only");
const CASSETTE_FILE = "evals/cassette.json";
const RESULTS_FILE = "evals/results.json";
const NOTES_FILE = "evals/failure-notes.json";
if (APPEND && (REPLAY || !ONLY)) throw new Error("--append needs --only <section> and a live run");

type SectionName = "dev" | "heldOut" | "heldOutAfterFix";
interface Spec {
  name: SectionName;
  file: string;
  metaFile: string;
  /** What changed in the system for this section (labelled variants only). */
  changes?: string[];
}
const SPECS: Spec[] = [
  { name: "dev", file: "evals/dataset.json", metaFile: "evals/dataset.meta.json" },
  { name: "heldOut", file: "evals/heldout.json", metaFile: "evals/heldout.meta.json" },
  {
    name: "heldOutAfterFix",
    file: "evals/heldout.json",
    metaFile: "evals/heldout.meta.json",
    changes: [
      'Adjudication token budget raised from 2,000 to 6,000 (llmAdjudicator in resolve.ts). MiMo is a reasoning model and reasoning tokens count against max_tokens: on two hard groups it spent the whole budget thinking and returned an empty answer (finish_reason "length").',
      "Nothing else changed: same rules, same prompt, same decision logic, same held-out file. Not blind: we saw the held-out failures before making this change.",
    ],
  },
];

// ---------------------------------------------------------------- inputs

const fresh = !REPLAY && !APPEND;
const cassette: Cassette = fresh
  ? { version: 1, model: "", recordedAt: new Date().toISOString(), systemSha: systemSha(), system: SYSTEM, requests: {}, datasets: {}, runs: [] }
  : (JSON.parse(readFileSync(CASSETTE_FILE, "utf8")) as Cassette);
const LIVE_RUNS = Number(argVal("--runs") ?? 3);
const model = REPLAY ? cassette.model : (await import("../src/server/env")).env.AI_MODEL;
if (APPEND && cassette.model !== model) throw new Error(`cassette was recorded with ${cassette.model}, not ${model}`);
cassette.model = model;
const modelShort = model.split("/").pop()!;
const currentSystem = systemSha();
const failureNotes: Record<string, string> = existsSync(NOTES_FILE) ? JSON.parse(readFileSync(NOTES_FILE, "utf8")) : {};
/** Notes are keyed "<failure key>" for the blind held-out set and "<section>:<failure key>" for any other section. */
const noteFor = (section: SectionName, key: string) => failureNotes[`${section}:${key}`] ?? (section === "heldOut" ? (failureNotes[key] ?? null) : null);

/** Live for this section? (fresh run: dev + heldOut; append: only the named section). Everything else replays. */
const isLive = (s: Spec) => (fresh ? s.name !== "heldOutAfterFix" && (!ONLY || s.name === ONLY) : APPEND && s.name === ONLY);
const hasRuns = (s: Spec) => cassette.runs.some((r) => r.dataset === s.name);
if (APPEND) cassette.runs = cassette.runs.filter((r) => r.dataset !== ONLY);

function load(spec: Spec) {
  const raw = readFileSync(spec.file, "utf8");
  const meta = JSON.parse(readFileSync(spec.metaFile, "utf8"));
  const sha = sha256(lf(raw)); // git may check JSON out with CRLF on Windows; the frozen hash is over LF
  if (sha !== meta.sha256) throw new Error(`${spec.file}: hash mismatch — eval sets are frozen; rebuild meta deliberately`);
  if (!isLive(spec) && cassette.datasets[spec.name] && cassette.datasets[spec.name] !== sha) throw new Error(`${spec.file} is not the dataset the cassette was recorded on`);
  return { meta, sha, data: JSON.parse(raw) as LabeledIdentity[] };
}

// ---------------------------------------------------------------- evaluate one section

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
type Row = Metrics & {
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
  group: string;
  note?: string;
}
type Cause = "rules" | "ai" | "ai_unavailable" | "none";
interface Failure {
  kind: "false_merge" | "missed_link";
  dataset: SectionName;
  key: string;
  runs: string;
  runCount: number;
  decidedBy: Cause;
  pairsAffected: number;
  entries: ExampleEntry[];
  detail: string;
  analysis: string | null;
}

const misses: string[] = [];
let totalCalls = 0;

async function evaluate(spec: Spec) {
  const { meta, sha, data } = load(spec);
  const live = isLive(spec);
  if (live) cassette.datasets[spec.name] = sha;
  const truth = truthOf(data);
  const base = baselines(data, truth);
  const outs: RunOutcome[] = [];
  const runsMeta: CassetteRun[] = [];
  const n = live ? LIVE_RUNS : Math.max(...cassette.runs.filter((r) => r.dataset === spec.name).map((r) => r.run));
  for (let i = 1; i <= n; i++) {
    let o: RunOutcome;
    let run: CassetteRun;
    if (live) {
      run = { dataset: spec.name, run: i, ms: 0, calls: [], ...(fresh ? {} : { recordedAt: new Date().toISOString(), systemSha: currentSystem }) };
      o = await runPaylet(data, truth, recorder(llmAdjudicator, run, cassette.requests));
      run.ms = o.ms;
      cassette.runs.push(run);
    } else {
      run = cassette.runs.find((r) => r.dataset === spec.name && r.run === i)!;
      if (!run) throw new Error(`cassette has no ${spec.name} run ${i}`);
      const rp = replayer(run);
      o = await runPaylet(data, truth, rp.adjudicator);
      o.ms = run.ms;
      misses.push(...rp.misses);
    }
    runsMeta.push(run);
    totalCalls += o.llmCalls;
    outs.push(o);
    const m = o.metrics;
    console.log(
      `[${spec.name}${live ? "" : " replay"}] run ${i}/${n}: P ${pct(m.precision)} R ${pct(m.recall)} F1 ${pct(m.f1)} · false merges ${m.falseMerges} · missed ${m.missedLinks} · ${o.llmCalls} calls · ${(o.ms / 1000).toFixed(1)}s${o.result.degraded ? ` · DEGRADED: ${o.result.degraded}` : ""}`,
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
  const recordedSha = runsMeta[0]?.systemSha ?? cassette.systemSha;
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
      recordedAt: runsMeta[0]?.recordedAt ?? cassette.recordedAt,
      systemSha: recordedSha,
      ...(spec.changes ? { changes: spec.changes } : {}),
    },
    failures: failures(spec.name, data, outs, runsMeta),
  };
}
type Evaluated = Awaited<ReturnType<typeof evaluate>>;

// ---------------------------------------------------------------- failures and examples

function entryOf(d: LabeledIdentity): ExampleEntry {
  const a = d.address;
  return {
    id: d.label ?? d.id,
    name: d.name,
    address: [a.line1, a.line2, a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    source: d.source ?? "human",
    origin: d.origin ?? "generated",
    group: d.group,
    ...(d.note ? { note: d.note } : {}),
  };
}

function failures(section: SectionName, data: LabeledIdentity[], outs: RunOutcome[], runsMeta: CassetteRun[]): Failure[] {
  const byId = new Map(data.map((d) => [d.id, d]));
  const band = new Map(allPairs(prepare(data)).map((p) => [pairKey(p.a, p.b), p.band]));
  const found = new Map<string, Failure & { seen: Set<number> }>();
  const add = (key: string, run: number, make: () => Failure) => {
    const f = found.get(key) ?? { ...make(), seen: new Set<number>() };
    // a false merge reports its worst run; a missed link keeps the run its detail describes
    if (f.kind === "false_merge") f.pairsAffected = Math.max(f.pairsAffected, make().pairsAffected);
    f.seen.add(run);
    found.set(key, f);
  };

  outs.forEach((o, run) => {
    // false merges, one failure per pair of true groups that got merged
    const byGroups = new Map<string, ReturnType<typeof bridges>>();
    for (const b of bridges(data, o.result)) {
      const gk = [byId.get(b.a)!.group, byId.get(b.b)!.group].sort().join("|");
      byGroups.set(gk, [...(byGroups.get(gk) ?? []), b]);
    }
    for (const [gk, bs] of byGroups) {
      const [ga, gb] = gk.split("|");
      const affected = o.metrics.falsePairs.filter((p) => {
        const [x, y] = p.split("|").map((id) => byId.get(id)!.group);
        return (x === ga && y === gb) || (x === gb && y === ga);
      }).length;
      const key = `merge:${gk}`;
      add(key, run, () => ({
        kind: "false_merge",
        dataset: section,
        key,
        runs: "",
        runCount: 0,
        decidedBy: bs.every((b) => b.by === "rules") ? "rules" : "ai",
        pairsAffected: affected,
        entries: data.filter((d) => d.group === ga || d.group === gb).map(entryOf),
        detail: bs
          .map((b) =>
            b.by === "rules"
              ? `${b.a} ↔ ${b.b} linked by the deterministic rules (score ${b.ruleScore}: ${b.signals.join("; ")}); rule-certain links never reach the model.`
              : `${b.a} ↔ ${b.b} linked by the model (${Math.round((b.confidence ?? 0) * 100)}%): "${b.explanation ?? ""}"`,
          )
          .join(" "),
        analysis: noteFor(section, key),
      }));
    }

    // missed links, one failure per true group, with the cause of each missed pair
    const failedIds: Set<string>[] = [...failedKeys(runsMeta[run])].map(
      (k) => new Set((JSON.parse(cassette.requests[k]).entries as { id: string }[]).map((e) => e.id)),
    );
    const missedByGroup = new Map<string, string[]>();
    for (const p of o.metrics.missedPairs) {
      const g = byId.get(p.split("|")[0])!.group;
      missedByGroup.set(g, [...(missedByGroup.get(g) ?? []), p]);
    }
    for (const [g, ps] of missedByGroup) {
      const causes = { ai_unavailable: 0, ai: 0, rules: 0, none: 0 };
      let keptReason: string | null = null;
      for (const p of ps) {
        const [a, b] = p.split("|");
        const la = byId.get(a)!.label ?? a;
        const lb = byId.get(b)!.label ?? b;
        const kept = o.result.keptApart.find((k) => pairKey(k.a, k.b) === pairKey(la, lb));
        if (failedIds.some((s) => s.has(la) && s.has(lb))) causes.ai_unavailable++;
        else if (kept) {
          causes.ai++;
          keptReason ??= `${la} ↔ ${lb}: "${kept.reason}"`;
        } else if (band.get(p) === "none" || band.get(p) === undefined) causes.rules++;
        else causes.none++;
      }
      const top = (Object.entries(causes) as [Cause, number][]).sort((x, y) => y[1] - x[1])[0][0];
      const parts = [
        causes.ai_unavailable && `${causes.ai_unavailable} were in a group the model never answered (empty or truncated answer on both attempts), so they stayed unmerged`,
        causes.ai && `${causes.ai} were kept apart by the model (e.g. ${keptReason})`,
        causes.rules && `${causes.rules} were never flagged by the rules (score below the review threshold), so the model never saw them`,
        causes.none && `${causes.none} were flagged but not reviewed together (split across model calls)`,
      ].filter(Boolean);
      const key = `group:${g}`;
      add(key, run, () => ({
        kind: "missed_link",
        dataset: section,
        key,
        runs: "",
        runCount: 0,
        decidedBy: top,
        pairsAffected: ps.length,
        entries: data.filter((d) => d.group === g).map(entryOf),
        detail: `Run ${run + 1}: ${ps.length} true pair${ps.length === 1 ? "" : "s"} missed: ${parts.join("; ")}.`,
        analysis: noteFor(section, key),
      }));
    }
  });
  return [...found.values()]
    .map(({ seen, ...f }) => ({ ...f, runCount: seen.size, runs: `${seen.size}/${outs.length} runs` }))
    .sort((x, y) => y.runCount - x.runCount || Number(y.kind === "false_merge") - Number(x.kind === "false_merge") || y.pairsAffected - x.pairsAffected);
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
  const hw = (x: { a: LabeledIdentity; b: LabeledIdentity }) => Number(x.a.origin === "handwritten" || x.b.origin === "handwritten");
  const kept = o.result.keptApart
    .map((k) => ({ k, a: byId.get(labelToId.get(k.a)!)!, b: byId.get(labelToId.get(k.b)!)! }))
    .filter((x) => x.a.group !== x.b.group)
    .sort((x, y) => hw(y) - hw(x))[0];
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
  if (f) out.push(failureExample(f));
  return out;
}

function failureExample(f: Failure) {
  return {
    type: "failure",
    dataset: f.dataset,
    title: f.kind === "false_merge" ? `False merge (${f.pairsAffected} pair${f.pairsAffected === 1 ? "" : "s"})` : `Missed link (${f.pairsAffected} pair${f.pairsAffected === 1 ? "" : "s"})`,
    entries: f.entries,
    decidedBy: f.decidedBy,
    verdict: f.kind === "false_merge" ? "Merged, but they are different people" : "Left apart, but they are the same household or operation",
    confidence: null,
    reason: f.detail,
    truth: f.kind === "false_merge" ? "different" : "same",
    correct: false,
    runsObserved: f.runs,
    analysis: f.analysis,
  };
}

// ---------------------------------------------------------------- run

const evaluated: Evaluated[] = [];
for (const spec of SPECS) {
  if (!isLive(spec) && !hasRuns(spec)) continue;
  if (!existsSync(spec.file)) {
    console.warn(`(skipping ${spec.name}: ${spec.file} not found)`);
    continue;
  }
  evaluated.push(await evaluate(spec));
}
const devOrNull = evaluated.find((e) => e.spec.name === "dev");
const held = evaluated.find((e) => e.spec.name === "heldOut");
const fixed = evaluated.find((e) => e.spec.name === "heldOutAfterFix");
if (!devOrNull) throw new Error("the dev set is required");
const dev: Evaluated = devOrNull;

const paylet = (e: Evaluated) => e.section.results.find((r) => r.id === "paylet")!;
const rules = (e: Evaluated) => e.section.results.find((r) => r.id === "rules")!;
const heldFailures = held?.failures ?? [];
const exampleList = examples(held ?? dev);
// the headline failure first; any other blind held-out failure mode with an analysis gets its own example card
for (const f of heldFailures.slice(1)) if (f.analysis) exampleList.push(failureExample(f));

const heldHeadline = (e: Evaluated) => ({
  precision: paylet(e).stats!.precision,
  recall: paylet(e).stats!.recall,
  f1: paylet(e).stats!.f1,
  falseMerges: paylet(e).stats!.falseMerges,
  missedLinks: paylet(e).stats!.missedLinks,
  falseMergesRules: rules(e).falseMerges,
  failures: e.failures.length,
  failuresExplained: e.failures.filter((f) => f.analysis).length,
});

const out = {
  schemaVersion: 2,
  ranAt: cassette.recordedAt,
  ...(REPLAY ? { replayedAt: new Date().toISOString() } : {}),
  mode: REPLAY ? "replay" : "live",
  model,
  runs: paylet(dev).runs!.length,
  system: { sha256: cassette.systemSha, files: SYSTEM_FILES, current: currentSystem },
  cassette: { file: CASSETTE_FILE, calls: cassette.runs.reduce((n, r) => n + r.calls.length, 0) },
  // dev (tuning) set — same fields as schema v1
  ...dev.section,
  heldOut: held
    ? {
        ...held.section,
        frozenSystemSha: held.section.dataset.frozenSystemSha ?? null,
        systemUnchangedSinceFreeze: held.section.dataset.frozenSystemSha === held.section.systemSha,
        failures: heldFailures,
      }
    : null,
  heldOutAfterFix: fixed ? { ...fixed.section, failures: fixed.failures } : null,
  headline: {
    falseMergesRulesDev: rules(dev).falseMerges,
    falseMergesPayletDev: paylet(dev).stats!.falseMerges,
    heldOut: held ? heldHeadline(held) : null,
    heldOutAfterFix: fixed ? heldHeadline(fixed) : null,
  },
  examples: exampleList,
  notes: [
    `Dev set: ${dev.section.truthPairs} true pairs; only ${dev.section.uncertainPairs} fuzzy pairs (of ${dev.section.totalPairs}) go to the model, everything else is decided by deterministic rules.`,
    held
      ? `Held-out set (blind): generated after the rules and prompt were frozen (other seed, other red-team template, hand-written neighbours, namesakes and forwarder customers). ${held.section.truthPairs} true pairs, ${held.section.uncertainPairs} fuzzy pairs sent to the model.`
      : "No held-out set yet.",
    ...(fixed ? [`After-fix section: the same held-out file re-run after one labelled change (${fixed.spec.changes![0].split(".")[0]}). Not blind.`] : []),
    `Paylet numbers are the mean of ${paylet(dev).runs!.length} independent model runs (± sample standard deviation); the worst run is published too.`,
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
    const pub = e.spec.name === "dev" ? published : published?.[e.spec.name];
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

if (WRITE && !misses.length) {
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
  return entries.map((x) => `  - \`${x.id}\` ${x.name} — ${x.address} (${x.source}${x.origin !== "generated" ? `, ${x.origin}` : ""}; true group \`${x.group}\`)`).join("\n");
}

function failuresMd(list: Failure[]) {
  return list.length
    ? list
        .map(
          (f) => `### ${f.kind === "false_merge" ? "False merge" : "Missed link"} · ${f.runs} · ${f.pairsAffected} pair${f.pairsAffected === 1 ? "" : "s"} · cause: ${f.decidedBy}
${entriesMd(f.entries)}

What happened: ${f.detail}

${f.analysis ? `**Our analysis:** ${f.analysis}` : "_Not analysed yet._"}`,
        )
        .join("\n\n")
    : "No failures in any run.";
}

function markdown() {
  const h = out.headline.heldOut;
  const hf = out.headline.heldOutAfterFix;
  const devP = paylet(dev);
  const fm = (s: Stat) => (s.max === 0 ? "0 in every run" : `${s.mean.toFixed(1)} on average, ${s.max} in the worst run`);
  const exMd = out.examples
    .map((x) => {
      const e = x as { type: string; title: string; entries: ExampleEntry[]; verdict: string; confidence: number | null; reason: string; runsObserved: string; dataset: string; analysis?: string | null };
      return `### ${e.type === "linked" ? "Linked" : e.type === "kept_apart" ? "Kept apart" : "Failure"}: ${e.title} (${e.dataset}, ${e.runsObserved})
${entriesMd(e.entries)}

${e.verdict}${e.confidence != null ? ` (${Math.round(e.confidence * 100)}%)` : ""}: ${e.reason}${e.analysis ? `\n\n**Our analysis:** ${e.analysis}` : ""}`;
    })
    .join("\n\n");

  return `# Entity-resolution evals

${
  h
    ? `**Held-out, blind (never used for tuning): precision ${pctStat(h.precision)}, recall ${pctStat(h.recall)}, F1 ${pctStat(h.f1)} over ${paylet(held!).runs!.length} runs; false merges ${fm(h.falseMerges)} (rules alone: ${h.falseMergesRules}); ${h.failures} failure mode${h.failures === 1 ? "" : "s"}, ${h.failuresExplained} explained below.**`
    : "**No held-out set yet.**"
}${hf ? `\nAfter one labelled, non-blind fix (token budget only): precision ${pctStat(hf.precision)}, recall ${pctStat(hf.recall)}, F1 ${pctStat(hf.f1)}; false merges ${fm(hf.falseMerges)}.` : ""}
On the dev set (the one we tuned on) the AI review takes rules-only false merges from **${rules(dev).falseMerges} → ${devP.stats!.falseMerges.mean.toFixed(1)}** (mean of ${devP.runs!.length} runs) with no missed links.

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
             seed?: number; origins?: Record<string, number>; frozenSystemSha?: string; frozenSystemCommit?: string };
  truthPairs: number; uncertainPairs: number; totalPairs: number; results: SystemResult[];
  recordedAt: string; systemSha: string;                                      // when / with which system files the model runs were recorded
  changes?: string[];                                                         // labelled variants only (heldOutAfterFix)
}
interface ExampleEntry { id: string; name: string; address: string; source: string; origin: "generated" | "redteam" | "handwritten";
                         group: string /* ground-truth group */; note?: string }
interface Failure {
  kind: "false_merge" | "missed_link"; dataset: string; key: string; runs: string /* "3/3 runs" */; runCount: number;
  decidedBy: "rules" | "ai" | "ai_unavailable" | "none";                       // main cause
  pairsAffected: number; entries: ExampleEntry[]; detail: string; analysis: string | null /* written by us after the run */;
}
interface Example {
  type: "linked" | "kept_apart" | "failure"; dataset: string; title: string; entries: ExampleEntry[];
  decidedBy: "rules" | "ai" | "ai_unavailable" | "none"; verdict: string; confidence: number | null; reason: string;
  evidence?: { field: string; detail: string }[]; truth: "same" | "different"; correct: boolean; runsObserved: string;
  analysis?: string | null;
}
interface HeldOutHeadline { precision: Stat; recall: Stat; f1: Stat; falseMerges: Stat; missedLinks: Stat; falseMergesRules: number;
                            failures: number; failuresExplained: number }
interface EvalResults extends DatasetSection {                                 // top level = dev set (schema v1 fields kept)
  schemaVersion: 2; ranAt: string; replayedAt?: string; mode: "live" | "replay"; model: string; runs: number;
  system: { sha256: string /* recorded */; files: string[]; current: string /* sha of the files in this checkout */ };
  cassette: { file: string; calls: number };
  heldOut: (DatasetSection & { frozenSystemSha: string | null; systemUnchangedSinceFreeze: boolean; failures: Failure[] }) | null;
  heldOutAfterFix: (DatasetSection & { failures: Failure[] }) | null;          // same file, after a labelled fix: NOT blind
  headline: {
    falseMergesRulesDev: number; falseMergesPayletDev: Stat;                   // tile: "False merges 13 → 0"
    heldOut: HeldOutHeadline | null;                                          // tile: "Held-out: P x% · R y% · n failures explained"
    heldOutAfterFix: HeldOutHeadline | null;
  };
  examples: Example[];                                                         // linked, kept_apart, then failure(s)
  notes: string[];
}
\`\`\`

## Protocol

1. **Dev set** — \`evals/dataset.json\` (${dev.section.dataset.entries} entries, ${dev.section.dataset.groups} true people/operations; SHA-256 \`${dev.section.dataset.sha256.slice(0, 16)}…\`). ${dev.section.dataset.generator}. The rules and the adjudication prompt were developed against this set, so its numbers are optimistic by construction.
2. **Held-out set (blind)** — ${
    held
      ? `\`evals/heldout.json\` (${held.section.dataset.entries} entries, ${held.section.dataset.groups} true groups; SHA-256 \`${held.section.dataset.sha256.slice(0, 16)}…\`), frozen ${held.section.dataset.frozenAt} and committed before any evaluation on it. ${held.section.dataset.generator}. It was generated **after** the system files (${SYSTEM_FILES.map((f) => `\`${f}\``).join(", ")}) were frozen at SHA-256 \`${String(held.section.dataset.frozenSystemSha).slice(0, 16)}…\`; the blind runs used system \`${held.section.systemSha.slice(0, 16)}…\` (${out.heldOut!.systemUnchangedSinceFreeze ? "unchanged since the freeze" : "**changed since the freeze**"}). The hand-written cases were written by the same team that wrote the rules, so this is an adversarial test, not a naive one. A first generation of this file was discarded before any evaluation because the red-team validator let a degenerate 3,000-character "address" through; the validator now rejects such rewrites.`
      : "not generated yet."
  }
3. **${devP.runs!.length} runs** — the model (temperature 0.1) is called ${devP.runs!.length} independent times per dataset; we publish mean ± sample standard deviation and the worst run. The baselines are deterministic.
4. **Replay** — every model answer (and every failed call) is stored in \`evals/cassette.json\` with the exact input it answered. \`pnpm evals --replay\` re-scores from the cassette with no key, no network and no app config, and fails if the numbers differ from \`evals/results.json\`; a unit test runs the same check in CI.
5. Metrics are pairwise over the transitive closure (what an allocation system would actually merge). A **false merge** takes a real fan's chance away; a **missed link** lets an operation enter more than once.

## Held-out set (blind)

${held ? table(held) : "_Not generated yet._"}

### Failures on the held-out set

${failuresMd(heldFailures)}
${
  fixed
    ? `
## Held-out set after one fix (not blind)

What changed:
${fixed.spec.changes!.map((c) => `- ${c}`).join("\n")}

Recorded ${fixed.section.recordedAt} with system \`${fixed.section.systemSha.slice(0, 16)}…\`.

${table(fixed)}

### Remaining failures after the fix

${failuresMd(fixed.failures)}
`
    : ""
}
## Dev set (tuned on it)

${table(dev)}

## Examples

${exMd}

## Honest caveats

- Both datasets are synthetic and built by us; the generators, the red-team prompts and the hand-written cases are in the repo.
- Rules alone are already strong on recall. The model's job is to remove false merges (a false merge costs a real fan their chance) and to explain decisions, including why it kept look-alikes apart. When the model fails, Paylet errs towards **not** merging.
- When the AI is unavailable, Paylet degrades to rules-only suggestions and says so; nothing is ever auto-merged — the seller confirms every cluster.

Recorded ${out.ranAt}${"replayedAt" in out ? ` (replayed ${out.replayedAt})` : ""} with \`${model}\`. Reproduce live with \`pnpm evals\` (needs an OpenAI-compatible key) or offline with \`pnpm evals --replay\`.
`;
}
