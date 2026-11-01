// The published eval numbers must be reproducible from the recorded model answers: no key, no network.
// If this fails, the rules/prompt changed after the evals were run — re-run `pnpm evals` and publish the new numbers.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { baselines, lf, replayer, runPaylet, sha256, truthOf, type Cassette } from "../src/server/er/evaluate";
import type { LabeledIdentity } from "../src/server/simulate";

const cassette = JSON.parse(readFileSync("evals/cassette.json", "utf8")) as Cassette;
const results = JSON.parse(readFileSync("evals/results.json", "utf8"));

type Row = { id: string; precision: number; recall: number; f1: number; falseMerges: number; missedLinks: number; runs?: Row[] & { run: number }[] };

describe("published evals replay from evals/cassette.json", () => {
  const sets = [
    { name: "dev", file: "evals/dataset.json", section: results },
    { name: "heldOut", file: "evals/heldout.json", section: results.heldOut },
  ];
  for (const { name, file, section } of sets) {
    it(`${name}: dataset hash, baselines and every recorded model run match results.json`, async () => {
      const raw = readFileSync(file, "utf8");
      expect(sha256(lf(raw))).toBe(section.dataset.sha256);
      expect(cassette.datasets[name]).toBe(section.dataset.sha256);
      const data = JSON.parse(raw) as LabeledIdentity[];
      const truth = truthOf(data);
      const rows = section.results as Row[];

      const b = baselines(data, truth);
      for (const [id, m] of [["exact", b.exact], ["rules", b.rules]] as const) {
        const pub = rows.find((r) => r.id === id)!;
        expect([m.falseMerges, m.missedLinks]).toEqual([pub.falseMerges, pub.missedLinks]);
      }

      const paylet = rows.find((r) => r.id === "paylet")!;
      const runs = cassette.runs.filter((r) => r.dataset === name);
      expect(runs.length).toBe(results.runs);
      for (const run of runs) {
        const rp = replayer(run);
        const o = await runPaylet(data, truth, rp.adjudicator);
        expect(rp.misses).toEqual([]);
        const pub = (paylet.runs as unknown as (Row & { run: number })[]).find((r) => r.run === run.run)!;
        expect([o.metrics.falseMerges, o.metrics.missedLinks]).toEqual([pub.falseMerges, pub.missedLinks]);
        expect(o.metrics.f1).toBeCloseTo(pub.f1, 12);
      }
    }, 60_000);
  }
});
