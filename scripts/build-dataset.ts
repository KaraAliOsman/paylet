// Builds the FROZEN adversarial eval dataset (evals/dataset.json).
// 1) A deterministic synthetic crowd (fans, households, reseller networks, hard negatives).
// 2) A red-team "scalper agent" (the LLM) rewrites every reseller network's entries to evade matching
//    while still shipping to the same physical suite. Its output is validated, then the file is hashed and frozen.
// Re-running this script creates a NEW dataset version; the evals must be tuned only against a frozen file.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { chatJson } from "../src/server/ai";
import { syntheticCrowd, type LabeledIdentity } from "../src/server/simulate";

const SEED = 20261112;
const base = syntheticCrowd(SEED, { fans: 70, networks: 7, netSize: 6, households: 8, neighbors: 10, namesakes: 8 }, "ev");

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["entries"],
  properties: {
    entries: {
      type: "array",
      minItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "trick", "new_name", "new_line1", "new_line2"],
        properties: { id: { type: "string" }, trick: { type: "string" }, new_name: { type: "string" }, new_line1: { type: "string" }, new_line2: { type: "string" } },
      },
    },
  },
};

const RED_TEAM = `You generate synthetic test data for a deduplication system used by small online shops.
The records below are orders from several customer accounts that all ship to ONE package-forwarding suite.
Produce a realistic, messy variation of each record — the kind of formatting differences real people type:
abbreviations vs full words (Rd/Road, Ste/Suite/Unit/#), spacing and punctuation, c/o or Attn lines, swapped name order,
initials, nicknames, transliterated names, a plausible typo in the street name.
Constraints: keep the same street number, the same suite number, the same city and the same ZIP, so every parcel still
reaches the same suite. Keep every id. Return one output object per input record (same count), and make each
new_name and new_line1/new_line2 differ from the input. "trick" = a short label of the variation you applied.`;

async function redTeam(group: LabeledIdentity[]): Promise<LabeledIdentity[]> {
  const res = await chatJson<{ entries: { id: string; trick: string; new_name: string; new_line1: string; new_line2: string }[] }>(
    "redteam_dataset",
    [
      { role: "system", content: RED_TEAM },
      { role: "user", content: JSON.stringify(group.map((g) => ({ id: g.id, name: g.name, line1: g.address.line1, line2: g.address.line2 ?? "", city: g.address.city, zip: g.address.zip }))) },
    ],
    "rewrites",
    SCHEMA,
    2000,
    0.9,
  );
  const num = group[0].address.line1.match(/^\d+/)?.[0] ?? "";
  if (process.env.DEBUG_REDTEAM) console.log(JSON.stringify(res).slice(0, 900));
  return group.map((g) => {
    const found = res.entries.find((x) => x.id === g.id);
    const r = found && { name: found.new_name, line1: found.new_line1, line2: found.new_line2 };
    // validation: keep the rewrite only if it still points at the same street number + suite digits
    const suiteDigits = (g.address.line2 ?? g.address.line1).match(/\d+/g)?.at(-1) ?? "";
    const ok = r && `${r.line1} ${r.line2}`.includes(num) && `${r.line1} ${r.line2}`.includes(suiteDigits);
    return ok ? { ...g, name: r.name, address: { ...g.address, line1: r.line1, line2: r.line2 } } : g;
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
  console.log(`red-team rewrote network ${g}`);
}
const dataset = base.map((e) => rewritten.get(e.id) ?? e);
const body = JSON.stringify(dataset, null, 1);
const sha256 = createHash("sha256").update(body).digest("hex");
mkdirSync("evals", { recursive: true });
writeFileSync("evals/dataset.json", body);
writeFileSync(
  "evals/dataset.meta.json",
  JSON.stringify(
    {
      sha256,
      entries: dataset.length,
      groups: new Set(dataset.map((d) => d.group)).size,
      kinds: dataset.reduce<Record<string, number>>((a, d) => ((a[d.kind] = (a[d.kind] ?? 0) + 1), a), {}),
      generator: `syntheticCrowd(seed ${SEED}) + LLM red-team rewrites of reseller networks (${accepted} rewrites accepted)`,
      frozenAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log("dataset frozen", dataset.length, "entries, sha256", sha256);
