// The published eval numbers must be reproducible from the recorded model answers: no key, no network.
// If this fails, the rules/prompt changed after the evals were run — re-run `pnpm evals` and publish the new numbers.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { baselines, lf, loadSystem, replayer, runPaylet, sha256, SYSTEM_DIRS, systemShaOf, truthOf, type Cassette, type SystemId } from "../src/server/er/evaluate";
import type { LabeledIdentity } from "../src/server/simulate";

const cassette = JSON.parse(readFileSync("evals/cassette.json", "utf8")) as Cassette;
const results = JSON.parse(readFileSync("evals/results.json", "utf8"));
const heldOutMeta = JSON.parse(readFileSync("evals/heldout.meta.json", "utf8"));

type Row = { id: string; precision: number; recall: number; f1: number; falseMerges: number; missedLinks: number; runs?: Row[] & { run: number }[] };

describe("the blind section runs the frozen system", () => {
  it("evals/systems/frozen is byte-identical to the system frozen before the held-out set was generated", () => {
    expect(systemShaOf(SYSTEM_DIRS.frozen)).toBe(heldOutMeta.frozenSystemSha);
  });
});

describe("published evals replay from evals/cassette.json", () => {
  const sets: { name: string; file: string; section: { dataset: { sha256: string }; results: Row[] }; system: SystemId }[] = [
    { name: "dev", file: "evals/dataset.json", section: results, system: "frozen" },
    { name: "heldOut", file: "evals/heldout.json", section: results.heldOut, system: "frozen" },
    ...(results.heldOutAfterFix ? [{ name: "heldOutAfterFix", file: "evals/heldout.json", section: results.heldOutAfterFix, system: "frozen" as const }] : []),
  ];
  for (const { name, file, section, system: systemId } of sets) {
    it(`${name}: dataset hash, baselines and every recorded model run match results.json`, async () => {
      const system = await loadSystem(systemId);
      const raw = readFileSync(file, "utf8");
      expect(sha256(lf(raw))).toBe(section.dataset.sha256);
      expect(cassette.datasets[name]).toBe(section.dataset.sha256);
      const data = JSON.parse(raw) as LabeledIdentity[];
      const truth = truthOf(data);
      const rows = section.results;

      const b = baselines(data, truth, system);
      for (const [id, m] of [["exact", b.exact], ["rules", b.rules]] as const) {
        const pub = rows.find((r) => r.id === id)!;
        expect([m.falseMerges, m.missedLinks]).toEqual([pub.falseMerges, pub.missedLinks]);
      }

      const paylet = rows.find((r) => r.id === "paylet")!;
      const runs = cassette.runs.filter((r) => r.dataset === name);
      expect(runs.length).toBe(results.runs);
      for (const run of runs) {
        const rp = replayer(run);
        const o = await runPaylet(data, truth, rp.adjudicator, system);
        expect(rp.misses).toEqual([]);
        const pub = (paylet.runs as unknown as (Row & { run: number })[]).find((r) => r.run === run.run)!;
        expect([o.metrics.falseMerges, o.metrics.missedLinks]).toEqual([pub.falseMerges, pub.missedLinks]);
        expect(o.metrics.f1).toBeCloseTo(pub.f1, 12);
      }
    }, 60_000);
  }
});
