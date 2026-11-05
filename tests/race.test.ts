import { describe, expect, it } from "vitest";
import { raceVsBallot } from "../src/web/race-logic";

describe("race vs ballot model", () => {
  const base = { units: 10, fans: 300 };
  it("with no scalper every way of selling reaches fans", () => {
    expect(raceVsBallot({ ...base, scalperAccounts: 0 })).toEqual({ race: 10, ballot: 10, paylet: 10 });
  });
  it("a race gives a small stack of bots everything; a ballot dilutes them", () => {
    const r = raceVsBallot({ ...base, scalperAccounts: 40 });
    expect(r.race).toBe(0);
    expect(r.ballot).toBeCloseTo(8.8, 1);
    expect(r.paylet).toBeGreaterThan(r.ballot);
    expect(r.paylet).toBeCloseTo(9.8, 1);
  });
  it("uses the measured recall honestly: with no linking Paylet is just a ballot", () => {
    const r = raceVsBallot({ ...base, scalperAccounts: 40, recall: 0 });
    expect(r.paylet).toBeLessThanOrEqual(r.ballot);
  });
  it("stays honest at the FTC's scale: the operator still takes units", () => {
    const r = raceVsBallot({ ...base, scalperAccounts: 1300 });
    expect(r.paylet).toBeLessThan(6);
    expect(r.paylet).toBeGreaterThan(r.ballot);
  });
});
