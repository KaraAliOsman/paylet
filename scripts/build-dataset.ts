// Builds a FROZEN adversarial eval dataset.
//
//   pnpm evals:dataset              dev set → evals/dataset.json (seed 20261112, red-team template v1). The rules and the
//                                   adjudication prompt were tuned on it. Re-running creates a NEW version: don't.
//   pnpm evals:dataset --heldout    held-out set → evals/heldout.json, generated only AFTER the system files were frozen:
//                                   another seed, another red-team template (v2), half the reseller networks human-paced
//                                   instead of a bot burst, plus hand-written neighbours, namesakes and forwarder customers
//                                   (evals/heldout.handwritten.json). Never tune the rules or the prompt against it.
//
// 1) A deterministic synthetic crowd (fans, households, reseller networks, hard negatives).
// 2) A red-team "scalper" prompt (the LLM) rewrites every reseller network's entries to evade matching while still
//    shipping to the same physical suite. Rewrites are validated (same street number + suite digits), then the file is
//    hashed (over LF) and frozen.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chatJson } from "../src/server/ai";
import { lf, sha256, systemSha } from "../src/server/er/evaluate";
import { rng, syntheticCrowd, type LabeledIdentity } from "../src/server/simulate";

const HELDOUT = process.argv.includes("--heldout");

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["entries"],
  properties: {
    entries: {
      type: "array",
      minItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "trick", "new_name", "new_line1", "new_line2"],
        properties: { id: { type: "string" }, trick: { type: "string" }, new_name: { type: "string" }, new_line1: { type: "string" }, new_line2: { type: "string" } },
      },
    },
  },
};

const RED_TEAM_V1 = `You generate synthetic test data for a deduplication system used by small online shops.
The records below are orders from several customer accounts that all ship to ONE package-forwarding suite.
Produce a realistic, messy variation of each record — the kind of formatting differences real people type:
abbreviations vs full words (Rd/Road, Ste/Suite/Unit/#), spacing and punctuation, c/o or Attn lines, swapped name order,
initials, nicknames, transliterated names, a plausible typo in the street name.
Constraints: keep the same street number, the same suite number, the same city and the same ZIP, so every parcel still
reaches the same suite. Keep every id. Return one output object per input record (same count), and make each
new_name and new_line1/new_line2 differ from the input. "trick" = a short label of the variation you applied.`;

// Written after the system was frozen; deliberately different tactics from v1.
const RED_TEAM_V2 = `You write test fixtures for an address-deduplication system used by small online shops.
Each input record is an order from a different customer account; all of them really ship to ONE parcel-forwarding suite.
Rewrite every record the way different people (or one person trying not to look like one person) would type it into a checkout form.
Use tactics such as: moving the suite into line 1 ("Ste 7B", "#7B", "No. 7B", "Unit 7-B", "STE7B"), a private-mailbox prefix ("PMB 7B"),
a building or floor prefix that does not change the suite ("Bldg 1, Ste 7B"), ZIP+4, ordinal or directional variants of the street name,
a company name or an "Attn"/"c/o" line, middle names or initials, nicknames, a relative's name, ALL CAPS or all lowercase,
and at most one typo per record. Use a different tactic mix for each record.
Hard constraints: keep the same street number, the same suite number and letter, the same city and the same 5-digit ZIP.
Keep every id and return exactly one object per input record. "trick" = a short label of what you changed.`;

const cfg = HELDOUT
  ? {
      seed: 20261101,
      tag: "ho",
      counts: { fans: 60, networks: 5, netSize: 5, households: 7, neighbors: 7, namesakes: 7 },
      template: { id: "v2", text: RED_TEAM_V2 },
      out: "evals/heldout.json",
      meta: "evals/heldout.meta.json",
      // a 2-hour drop window; entrants get timestamps inside it
      window: { from: Date.UTC(2026, 10, 1, 16, 0, 0), to: Date.UTC(2026, 10, 1, 18, 0, 0) },
    }
  : {
      seed: 20261112,
      tag: "ev",
      counts: { fans: 70, networks: 7, netSize: 6, households: 8, neighbors: 10, namesakes: 8 },
      template: { id: "v1", text: RED_TEAM_V1 },
      out: "evals/dataset.json",
      meta: "evals/dataset.meta.json",
      window: undefined,
    };

if (HELDOUT && existsSync(cfg.out) && !process.argv.includes("--force")) {
  throw new Error(`${cfg.out} already exists and is frozen; pass --force only if you mean to publish a NEW held-out version`);
}

const base = syntheticCrowd(cfg.seed, cfg.counts, cfg.tag, cfg.window ? { window: cfg.window } : {});
if (HELDOUT) {
  // Half of the reseller networks trickle in like humans (no burst, no "agent" label): no timing signal to lean on.
  const r = rng(cfg.seed ^ 0x0ddba11);
  for (const e of base) {
    const idx = Number(e.group.match(/net(\d+)$/)?.[1] ?? -1);
    if (e.kind === "reshipper_network" && idx % 2 === 1) {
      e.source = "human";
      e.ts = Math.round(cfg.window!.from + r() * (cfg.window!.to - cfg.window!.from));
    }
  }
}

type Rewrites = { entries: { id: string; trick: string; new_name: string; new_line1: string; new_line2: string }[] };
async function redTeam(group: LabeledIdentity[]): Promise<LabeledIdentity[]> {
  let res: Rewrites | null = null;
  for (let attempt = 1; !res; attempt++) {
    try {
      res = await chatJson<Rewrites>(
        "redteam_dataset",
        [
          { role: "system", content: cfg.template.text },
          { role: "user", content: JSON.stringify(group.map((g) => ({ id: g.id, name: g.name, line1: g.address.line1, line2: g.address.line2 ?? "", city: g.address.city, zip: g.address.zip }))) },
        ],
        "rewrites",
        SCHEMA,
        4000,
        0.9,
      );
    } catch (e) {
      // a truncated or malformed answer: ask again (the generator is not the system under test)
      if (attempt >= 3) throw e;
      console.warn(`red-team answer unusable (${String(e).slice(0, 80)}), retrying`);
    }
  }
  const num = group[0].address.line1.match(/^\d+/)?.[0] ?? "";
  if (process.env.DEBUG_REDTEAM) console.log(JSON.stringify(res).slice(0, 900));
  return group.map((g) => {
    const found = res.entries.find((x) => x.id === g.id);
    const r = found && { name: found.new_name, line1: found.new_line1, line2: found.new_line2 };
    // validation: keep the rewrite only if it still points at the same street number + suite digits,
    // and (v2) only if it is something a person would type: no essays, no meta-notes about the data
    const suiteDigits = (g.address.line2 ?? g.address.line1).match(/\d+/g)?.at(-1) ?? "";
    const typed = r && `${r.line1} ${r.line2}`;
    const plausible = !HELDOUT || (r && r.name.length <= 50 && r.line1.length <= 70 && r.line2.length <= 70 && !/placeholder|do not use|test fixture/i.test(`${typed} ${r.name}`));
    const ok = r && plausible && typed!.includes(num) && typed!.includes(suiteDigits);
    return ok ? { ...g, name: r.name, address: { ...g.address, line1: r.line1, line2: r.line2 }, ...(HELDOUT ? { origin: "redteam" as const } : {}) } : g;
  });
}

const groups = new Map<string, LabeledIdentity[]>();
for (const e of base) if (e.kind === "reshipper_network") groups.set(e.group, [...(groups.get(e.group) ?? []), e]);

const rewritten = new Map<string, LabeledIdentity>();
let accepted = 0;
for (const [g, members] of [...groups].slice(0, process.env.DEBUG_REDTEAM ? 1 : 99)) {
  const out = await redTeam(members);
  out.forEach((m, i) => {
    rewritten.set(m.id, m);
    if (m.name !== members[i].name || m.address.line1 !== members[i].address.line1) accepted++;
  });
  console.log(`red-team (${cfg.template.id}) rewrote network ${g}`);
}

let dataset: LabeledIdentity[] = base.map((e) => rewritten.get(e.id) ?? e);
let handwritten = 0;
if (HELDOUT) {
  for (const e of dataset) e.origin ??= "generated";
  const hw = JSON.parse(readFileSync("evals/heldout.handwritten.json", "utf8")) as LabeledIdentity[];
  const r = rng(cfg.seed ^ 0x4a11d);
  for (const e of hw) {
    e.origin = "handwritten";
    e.source ??= "human";
    e.ts = Math.round(cfg.window!.from + r() * (cfg.window!.to - cfg.window!.from));
  }
  // the agent-run forwarder network arrives as a burst
  const burst = hw.filter((e) => e.source === "agent");
  burst.forEach((e, k) => (e.ts = burst[0].ts! + k * 3000));
  handwritten = hw.length;
  // interleave deterministically so hand-written cases are not one block at the end
  dataset = [...dataset, ...hw];
  for (let i = dataset.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [dataset[i], dataset[j]] = [dataset[j], dataset[i]];
  }
}

const body = JSON.stringify(dataset, null, 1);
const hash = sha256(lf(body));
mkdirSync("evals", { recursive: true });
writeFileSync(cfg.out, body);
const commit = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
})();
writeFileSync(
  cfg.meta,
  JSON.stringify(
    {
      sha256: hash,
      entries: dataset.length,
      groups: new Set(dataset.map((d) => d.group)).size,
      kinds: dataset.reduce<Record<string, number>>((a, d) => ((a[d.kind] = (a[d.kind] ?? 0) + 1), a), {}),
      generator: HELDOUT
        ? `syntheticCrowd(seed ${cfg.seed}) + LLM red-team template ${cfg.template.id} (${accepted} rewrites accepted; half the networks human-paced) + ${handwritten} hand-written hard cases`
        : `syntheticCrowd(seed ${cfg.seed}) + LLM red-team rewrites of reseller networks (${accepted} rewrites accepted)`,
      frozenAt: new Date().toISOString(),
      ...(HELDOUT
        ? {
            seed: cfg.seed,
            redTeamTemplate: cfg.template.id,
            origins: dataset.reduce<Record<string, number>>((a, d) => ((a[d.origin ?? "generated"] = (a[d.origin ?? "generated"] ?? 0) + 1), a), {}),
            frozenSystemSha: systemSha(),
            frozenSystemCommit: commit,
            protocol: "Generated after the system files (normalize.ts, rules.ts, resolve.ts incl. the prompt) were frozen at frozenSystemSha. Not used for tuning.",
          }
        : {}),
    },
    null,
    2,
  ),
);
console.log("dataset frozen", cfg.out, dataset.length, "entries, sha256", hash);
