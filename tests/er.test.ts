// Entity resolution with a fake model: validation, retries, partial failure, "kept apart" and honest labels.
import { describe, expect, it } from "vitest";
import type { Identity } from "../src/server/er/normalize";
import { resolve, type AdjudicationRequest, type Adjudicator } from "../src/server/er/resolve";
import { formatDuration, prepare, scorePair } from "../src/server/er/rules";
import { syntheticCrowd } from "../src/server/simulate";

const T0 = Date.UTC(2026, 10, 1, 17, 0, 0);
const ident = (id: string, label: string, name: string, line1: string, line2: string | undefined, zip: string, extra: Partial<Identity> = {}): Identity => ({
  id,
  label,
  name,
  email: `${id}@example.com`,
  address: { line1, line2, zip, city: "Portland", state: "OR" },
  ts: T0,
  source: "human",
  ...extra,
});

// Two neighbours (different apartments), one single-family household, one rule-certain forwarder suite.
const crowd: Identity[] = [
  ident("ent_internal_a", "E-AAAA", "Iris Chen", "88 Cedar St", "Apt 2A", "97205"),
  ident("ent_internal_b", "E-BBBB", "Noah Silva", "88 Cedar St", "Apt 5C", "97205"),
  ident("ent_internal_c", "E-CCCC", "Ji-woo Park", "14 Willow Way", undefined, "97212"),
  ident("ent_internal_d", "E-DDDD", "Daniel Okafor", "14 Willow Way", undefined, "97212"),
  ident("ent_internal_e", "E-EEEE", "Maya Tanaka", "1200 Harbor Blvd", "Ste 4B", "97201", { source: "agent", ts: T0 + 1000 }),
  ident("ent_internal_f", "E-FFFF", "Tanaka Maya", "1200 Harbor Boulevard", "Suite 4B", "97201", { source: "agent", ts: T0 + 3000 }),
  ident("ent_internal_g", "E-GGGG", "Omar Haddad", "1200 Harbor Blvd #4-B", undefined, "97201", { source: "agent", ts: T0 + 6000 }),
];

type Entry = { id: string; unit: string | null; street: string };
function parse(req: AdjudicationRequest) {
  return JSON.parse(req.user) as { entries: Entry[]; deterministic_signals: { a: string; b: string }[] };
}

/** A well-behaved fake model: same street without unit => household, otherwise distinct with a reason. */
const goodModel: Adjudicator = async (req) => {
  const { entries } = parse(req);
  const ids = entries.map((e) => e.id);
  if (entries.every((e) => !e.unit) && new Set(entries.map((e) => e.street)).size === 1) {
    return {
      groups: [{ member_ids: ids, verdict: "same_household", confidence: 0.82, evidence: [{ field: "address", detail: "same single-family home" }, { field: "street", detail: "14 WILLOW WAY" }, { field: "Address / unit", detail: "no unit" }, { field: "name and timing", detail: "different surnames" }], explanation: "Two people in one home." }],
      kept_apart: [],
    };
  }
  return {
    groups: ids.map((id) => ({ member_ids: [id], verdict: "distinct", confidence: 0.9, evidence: [], explanation: "" })),
    kept_apart: [{ a: ids[0], b: ids[1], reason: "Different apartments (2A vs 5C) and unrelated surnames.", confidence: 0.93 }],
  };
};

describe("resolve: AI adjudication contract", () => {
  it("shows the model only public labels and relative times, and returns kept-apart pairs by label", async () => {
    const seen: string[] = [];
    const r = await resolve(crowd, { useLlm: true, adjudicator: async (req) => (seen.push(req.user), goodModel(req)) });
    expect(seen.length).toBe(2); // two uncertain components; the rule-certain suite never reaches the model
    for (const u of seen) {
      expect(u).not.toContain("ent_internal");
      expect(u).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no wall-clock timestamps
    }
    expect(r.degraded).toBeNull();
    expect(r.keptApart).toEqual([{ a: "E-AAAA", b: "E-BBBB", reason: "Different apartments (2A vs 5C) and unrelated surnames.", confidence: 0.93 }]);
    const hh = r.clusters.find((c) => c.memberIds.includes("ent_internal_c"))!;
    expect(hh.method).toBe("ai");
    expect(hh.kind).toBe("household"); // the model's verdict wins over the "different surnames" heuristic
    expect(hh.normalizedKey).toBe("14 WILLOW WAY 97212");
    const suite = r.clusters.find((c) => c.memberIds.includes("ent_internal_e"))!;
    expect(suite.method).toBe("rules");
    expect(suite.memberIds).toHaveLength(3);
    expect(suite.normalizedKey).toBe("1200 HARBOR BLVD STE 4B 97201");
  });

  it("keeps at most one evidence item per field, model wording first, and summarises agent timing once", async () => {
    const r = await resolve(crowd, { useLlm: true, adjudicator: goodModel });
    for (const c of r.clusters) {
      const fields = c.evidence.map((e) => e.field);
      expect(new Set(fields).size).toBe(fields.length);
    }
    const hh = r.clusters.find((c) => c.memberIds.includes("ent_internal_c"))!;
    expect(hh.evidence.find((e) => e.field === "address")!.detail).toBe("same single-family home");
    expect(hh.evidence.find((e) => e.field === "name")!.detail).toBe("different surnames"); // "name and timing" -> name
    const suite = r.clusters.find((c) => c.memberIds.includes("ent_internal_e"))!;
    expect(suite.evidence.find((e) => e.field === "timing")!.detail).toBe("3 agent entries within 5 s");
  });

  it("retries an invalid answer once, then uses the valid one", async () => {
    let calls = 0;
    const flaky: Adjudicator = async (req) => (++calls === 1 ? { groups: [{ member_ids: "nope" }] } : goodModel(req));
    const r = await resolve(crowd, { useLlm: true, adjudicator: flaky });
    expect(r.degraded).toBeNull();
    expect(r.llmCalls).toBe(3);
    expect(r.keptApart).toHaveLength(1);
  });

  it("rejects answers that put one entry in two groups", async () => {
    const twice: Adjudicator = async (req) => {
      const ids = parse(req).entries.map((e) => e.id);
      return {
        groups: [
          { member_ids: ids, verdict: "same_household", confidence: 0.9, evidence: [], explanation: "x" },
          { member_ids: [ids[0]], verdict: "same_operator", confidence: 0.9, evidence: [], explanation: "y" },
        ],
        kept_apart: [],
      };
    };
    const r = await resolve(crowd, { useLlm: true, adjudicator: twice });
    expect(r.degraded).toMatch(/could not answer for 2 of 2 groups|unavailable/);
    expect(r.clusters.every((c) => c.method === "rules")).toBe(true);
  });

  it("skips a group the model cannot answer and still reviews the others", async () => {
    const partial: Adjudicator = async (req) => {
      if (parse(req).entries.some((e) => e.street === "88 CEDAR ST")) throw new Error("AI HTTP 500");
      return goodModel(req);
    };
    const r = await resolve(crowd, { useLlm: true, adjudicator: partial });
    expect(r.clusters.some((c) => c.memberIds.includes("ent_internal_c") && c.method === "ai")).toBe(true);
    expect(r.unreviewedPairs).toBe(1);
    expect(r.keptApart).toEqual([]); // never claim the AI kept apart a pair it did not review
    expect(r.degraded).toBe("The AI reviewer could not answer for 1 of 2 groups: 1 uncertain pair was not reviewed and stays unmerged. Rule-certain clusters are unaffected.");
    expect(r.aiDegraded).toContain("AI HTTP 500");
  });

  it("stops calling the model when the daily budget is used up", async () => {
    class BudgetExceeded extends Error {}
    let calls = 0;
    const broke: Adjudicator = async () => {
      calls++;
      throw new BudgetExceeded("daily AI budget reached");
    };
    const r = await resolve(crowd, { useLlm: true, adjudicator: broke });
    expect(calls).toBe(1);
    expect(r.degraded).toMatch(/^The daily AI budget is used up: 2 uncertain pairs were not reviewed/);
    expect(r.clusters.filter((c) => c.method === "rules")).toHaveLength(1);
  });

  it("does not act on low-confidence links and explains why the pair stayed apart", async () => {
    const unsure: Adjudicator = async (req) => {
      const ids = parse(req).entries.map((e) => e.id);
      return { groups: [{ member_ids: ids, verdict: "same_household", confidence: 55, evidence: [], explanation: "maybe" }], kept_apart: [] };
    };
    const r = await resolve(crowd, { useLlm: true, adjudicator: unsure });
    expect(r.clusters.some((c) => c.method === "ai")).toBe(false);
    expect(r.keptApart.map((k) => k.reason)).toContain("The model leaned towards linking them but was only 55% sure, so they stay separate.");
  });
});

describe("rule signals read like sentences", () => {
  const p = (id: string, line1: string, line2: string | undefined, extra: Partial<Identity> = {}) =>
    prepare([{ id, name: id, address: { line1, line2, zip: "97205" }, ...extra }])[0];
  it("says 'no unit' instead of a dash", () => {
    const s = scorePair(p("a", "18 Alder St", undefined), p("b", "18 Alder St", "Unit B"));
    expect(s.signals[0].detail).toBe("same building 18 ALDER ST 97205, different units (no unit vs unit B)");
    const h = scorePair(p("a", "18 Alder St", undefined), p("b", "18 Alder Street", undefined));
    expect(h.signals[0].detail).toBe("same street address, no unit, in 97205");
  });
  it("labels simulated bots as simulated, never as agents", () => {
    const a = p("a", "1 Dock Rd", "Ste 9", { ts: T0, source: "simulated", agentLabel: "simulated-scalper-bot" });
    const b = p("b", "1 Dock Rd", "Ste 9", { ts: T0 + 4000, source: "simulated", agentLabel: "simulated-scalper-bot" });
    expect(scorePair(a, b).signals.find((s) => s.field === "timing")!.detail).toBe("simulated bot entries 4 s apart");
    const c = p("c", "1 Dock Rd", "Ste 9", { ts: T0, source: "simulated" });
    const d = p("d", "1 Dock Rd", "Ste 9", { ts: T0 + 4000, source: "simulated" });
    expect(scorePair(c, d).signals.some((s) => s.field === "timing")).toBe(false);
  });
  it("formats durations for humans", () => {
    expect(formatDuration(4000)).toBe("4 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
    expect(formatDuration(3_780_000)).toBe("1 h 3 min");
  });
});

describe("simulated crowd", () => {
  const counts = { fans: 12, networks: 1, netSize: 6, households: 1, neighbors: 1, namesakes: 1 };
  it("places every entrant inside the drop window, sorted, with the network as one bot burst", () => {
    const from = T0;
    const to = T0 + 10 * 60_000;
    const c = syntheticCrowd(42, counts, "sim42", { window: { from, to }, simulated: true });
    expect(c.every((e) => e.ts! >= from && e.ts! <= to)).toBe(true);
    expect(c.map((e) => e.ts)).toEqual([...c.map((e) => e.ts!)].sort((a, b) => a - b));
    expect(c.every((e) => e.source === "simulated")).toBe(true);
    const net = c.filter((e) => e.kind === "reshipper_network");
    expect(net.every((e) => e.agentLabel === "simulated-scalper-bot")).toBe(true);
    expect(c.filter((e) => e.kind !== "reshipper_network").every((e) => !e.agentLabel)).toBe(true);
    const span = Math.max(...net.map((e) => e.ts!)) - Math.min(...net.map((e) => e.ts!));
    expect(span).toBeLessThanOrEqual(30_000);
  });
  it("compresses the burst into a window that is too short", () => {
    const c = syntheticCrowd(1, counts, "s1", { window: { from: T0, to: T0 + 5000 }, simulated: true });
    expect(c.every((e) => e.ts! >= T0 && e.ts! <= T0 + 5000)).toBe(true);
  });
  it("keeps identities byte-identical for a seed (eval datasets stay reproducible)", () => {
    const a = syntheticCrowd(7, counts, "x");
    const b = syntheticCrowd(7, counts, "x", { window: { from: T0, to: T0 + 60_000 }, simulated: true });
    const strip = (l: typeof a) => l.map(({ ts: _t, source: _s, agentLabel: _l, ...rest }) => rest).sort((p, q) => p.id.localeCompare(q.id));
    expect(strip(b)).toEqual(strip(a));
    expect(a.filter((e) => e.kind === "reshipper_network").every((e) => e.source === "agent")).toBe(true);
    expect(a.filter((e) => e.kind !== "reshipper_network").every((e) => e.source === undefined)).toBe(true);
  });
});

describe("resolve: large components", () => {
  it("splits a component bigger than one call so that look-alikes stay in the same chunk", async () => {
    // one building, 14 apartments: pairs 2A/2A' are the same unit (rule-certain), all others differ (uncertain)
    const names = ["Iris Chen", "Noah Silva", "Maya Okafor", "Leo Brennan", "Ana Petrov", "Omar Fischer", "Grace Rossi", "Kenji Walsh", "Elena Kaur", "Diego Moreau", "Hana Novak", "Felix Abara", "Zoe Delgado", "Ravi Haddad"];
    const building: Identity[] = names.map((name, i) => ident(`ent_${i}`, `E-${String(i).padStart(4, "0")}`, name, "500 Tower Ave", `Apt ${Math.floor(i / 2) + 1}A`, "97209"));
    const chunks: string[][] = [];
    const r = await resolve(building, {
      useLlm: true,
      chunkSize: 4,
      adjudicator: async (req) => {
        const ids = parse(req).entries.map((e) => e.id);
        chunks.push(ids);
        return { groups: ids.map((id) => ({ member_ids: [id], verdict: "distinct", confidence: 0.9, evidence: [], explanation: "" })), kept_apart: [] };
      },
    });
    expect(chunks.flat().sort()).toEqual(building.map((b) => b.label).sort());
    // every same-apartment pair (rule-certain link) is reviewed together
    for (let i = 0; i < 14; i += 2) expect(chunks.some((c) => c.includes(building[i].label!) && c.includes(building[i + 1].label!))).toBe(true);
    // cross-chunk pairs are counted as not reviewed, and said out loud: never a silent partial review
    expect(r.unreviewedPairs).toBeGreaterThan(0);
    expect(r.degraded).toBe(
      `The AI reviewed ${r.uncertainPairs - r.unreviewedPairs} of ${r.uncertainPairs} uncertain pairs: the other ${r.unreviewedPairs} sit in a look-alike group too large to review in one call and stay unmerged. Rule-certain clusters are unaffected.`,
    );
  });

  it("reports split pairs next to a failed call", async () => {
    const names = ["Iris Chen", "Noah Silva", "Maya Okafor", "Leo Brennan", "Ana Petrov", "Omar Fischer"];
    const building: Identity[] = names.map((name, i) => ident(`ent_${i}`, `E-${String(i).padStart(4, "0")}`, name, "500 Tower Ave", `Apt ${i + 1}`, "97209"));
    let calls = 0;
    const r = await resolve(building, {
      useLlm: true,
      chunkSize: 3,
      adjudicator: async (req) => {
        if (++calls <= 2) throw new Error("AI HTTP 500"); // first chunk fails twice
        const ids = parse(req).entries.map((e) => e.id);
        return { groups: ids.map((id) => ({ member_ids: [id], verdict: "distinct", confidence: 0.9, evidence: [], explanation: "" })), kept_apart: [] };
      },
    });
    expect(r.uncertainPairs).toBe(15);
    expect(r.unreviewedPairs).toBe(12); // 3 in the failed chunk + 9 across the two chunks
    expect(r.degraded).toBe(
      "The AI reviewer could not answer for 1 of 2 groups: 3 uncertain pairs were not reviewed and stay unmerged. Another 9 look-alike pairs sit in a group too large to review in one call and stay unmerged. Rule-certain clusters are unaffected.",
    );
  });

  it("stays fast and honest on a 300-entry building", async () => {
    const first = ["Iris", "Noah", "Maya", "Leo", "Ana", "Omar", "Grace", "Kenji", "Elena", "Diego", "Hana", "Felix", "Zoe", "Ravi", "Uma", "Bruno", "Talia", "Yusuf", "Wendy", "Pavel"];
    const last = ["Chen", "Silva", "Okafor", "Brennan", "Petrov", "Fischer", "Rossi", "Walsh", "Kaur", "Moreau", "Novak", "Abara", "Delgado", "Haddad", "Lindqvist"];
    const building: Identity[] = Array.from({ length: 300 }, (_, i) =>
      ident(`ent_${i}`, `E-${String(i).padStart(4, "0")}`, `${first[i % 20]} ${last[Math.floor(i / 20)]}`, "1 Tower Plaza", `Apt ${i + 1}`, "10001"),
    );
    const t = Date.now();
    const r = await resolve(building, {
      useLlm: true,
      adjudicator: async (req) => ({
        groups: parse(req).entries.map((e) => ({ member_ids: [e.id], verdict: "distinct", confidence: 0.9, evidence: [], explanation: "" })),
        kept_apart: [],
      }),
    });
    expect(Date.now() - t).toBeLessThan(10_000); // it took over a minute with the old edge-sorting split
    expect(r.llmCalls).toBe(25);
    expect(r.unreviewedPairs).toBeGreaterThan(40_000);
    const n = (k: number) => k.toLocaleString("en-US");
    expect(r.degraded).toBe(
      `The AI reviewed ${n(r.uncertainPairs - r.unreviewedPairs)} of ${n(r.uncertainPairs)} uncertain pairs: the other ${n(r.unreviewedPairs)} sit in a look-alike group too large to review in one call and stay unmerged. Rule-certain clusters are unaffected.`,
    );
  }, 30_000);
});
