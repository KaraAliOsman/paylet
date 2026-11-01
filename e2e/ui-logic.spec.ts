// Pure UI logic (no browser): the hold timeline model, the /verify reconciliation, the ledger and the seller console helpers.
import { expect, test } from "@playwright/test";
import { holdSteps, approvalExpiresAt } from "../src/web/timeline";
import { reconcile } from "../src/web/verify-logic";
import { cleanEventMessage, groupEvents, traceStatus } from "../src/web/ledger-logic";
import { addressDiff, demoTracking, drawPreview, pendingCopy, prettyModel, sortClusters, swarmResult } from "../src/web/console-logic";
import type { Cluster, SellerEntry } from "../src/web/api";

const base = { holdCents: 4800, capturedCents: null, closesAt: Date.now() + 600_000, dropStatus: "open" };

test.describe("holdSteps", () => {
  test("awaiting the person: approval is the current step, nothing after it has happened", () => {
    const s = holdSteps({ ...base, status: "awaiting_person" });
    expect(s.map((x) => x.state)).toEqual(["done", "current", "todo", "todo", "todo"]);
    expect(s[1].label).toBe("You approve in PayPal");
  });

  test("captured winner: partial capture and released remainder", () => {
    const s = holdSteps({ ...base, status: "captured", capturedCents: 4450, dropStatus: "settled" });
    expect(s.at(-1)).toMatchObject({ state: "win", label: "Captured $44.50 + $3.50 released" });
  });

  test("loser and failed payment end at $0", () => {
    expect(holdSteps({ ...base, status: "voided", dropStatus: "settled" }).at(-1)?.label).toBe("Voided, $0 charged");
    expect(holdSteps({ ...base, status: "capture_failed", dropStatus: "settled" }).at(-1)).toMatchObject({
      state: "bad",
      label: "Payment failed → unit passed on",
    });
  });

  test("same-account duplicate stops at the hold step", () => {
    const s = holdSteps({ ...base, status: "duplicate" });
    expect(s).toHaveLength(3);
    expect(s[2]).toMatchObject({ state: "bad", label: "No hold placed" });
  });

  test("frozen drop: the draw waits for public randomness", () => {
    const s = holdSteps({ ...base, status: "held", dropStatus: "frozen" });
    expect(s[3]).toMatchObject({ state: "current", label: "Drawing now" });
  });

  test("approval links expire after 3 h or at close, whichever is first", () => {
    expect(approvalExpiresAt(1_000, 10_000_000_000)).toBe(1_000 + 3 * 3600_000);
    expect(approvalExpiresAt(1_000, 5_000)).toBe(5_000);
  });
});

test.describe("reconcile", () => {
  const ranking = ["A", "B", "C", "D", "E", "F"];

  test("clean settlement is consistent", () => {
    const r = reconcile(ranking, 2, 2, [
      { publicId: "A", status: "captured" },
      { publicId: "B", status: "captured" },
      { publicId: "C", status: "voided" },
      { publicId: "D", status: "voided" },
      { publicId: "E", status: "voided" },
      { publicId: "F", status: "voided" },
    ]);
    expect(r.consistent).toBe(true);
    expect(r.rows.map((x) => x.computed.kind)).toEqual(["winner", "winner", "waitlist", "waitlist", "out", "out"]);
  });

  test("a failed winner passes the unit to waitlist #1", () => {
    const r = reconcile(ranking, 2, 2, [
      { publicId: "A", status: "captured" },
      { publicId: "B", status: "capture_failed" },
      { publicId: "C", status: "captured" },
    ]);
    expect(r.consistent).toBe(true);
    expect(r.rows[1].passedTo).toEqual({ publicId: "C", waitlistN: 1 });
    expect(r.rows[2].tookFrom).toBe("B");
  });

  test("older servers list only paid/failed entries: missing means not charged", () => {
    const r = reconcile(ranking, 2, 2, [
      { publicId: "A", status: "captured" },
      { publicId: "B", status: "won" },
    ]);
    expect(r.consistent).toBe(true);
  });

  test("charging someone the draw did not select is flagged", () => {
    const r = reconcile(ranking, 2, 2, [
      { publicId: "A", status: "captured" },
      { publicId: "B", status: "captured" },
      { publicId: "E", status: "captured" },
    ]);
    expect(r.consistent).toBe(false);
    expect(r.problems.join(" ")).toContain("E was charged");
  });

  test("skipping the waitlist order is flagged", () => {
    const r = reconcile(ranking, 2, 2, [
      { publicId: "A", status: "captured" },
      { publicId: "B", status: "capture_failed" },
      { publicId: "D", status: "captured" },
    ]);
    expect(r.consistent).toBe(false);
  });

  test("settlement in progress is neither consistent nor inconsistent yet", () => {
    const r = reconcile(ranking, 2, 2, [
      { publicId: "A", status: "captured" },
      { publicId: "B", status: "capture_failed" },
      { publicId: "C", status: "waitlist" },
    ]);
    expect(r.consistent).toBeNull();
  });
});

test.describe("ledger", () => {
  const ev = (id: number, kind: string, message: string, real: 0 | 1 = 0) => ({ id, ts: id * 1000, kind, message, real });

  test("three or more simulated events of one kind fold into one row; real calls never fold", () => {
    const items = groupEvents([
      ev(1, "draw", "Draw"),
      ev(2, "void_sim", "SIMULATED hold release for E-1"),
      ev(3, "void_sim", "SIMULATED hold release for E-2"),
      ev(4, "void_sim", "SIMULATED hold release for E-3"),
      ev(5, "voided", "Hold released for E-4", 1),
      ev(6, "voided", "Hold released for E-5", 1),
      ev(7, "voided", "Hold released for E-6", 1),
      ev(8, "capture_sim", "Simulated capture for E-7"),
      ev(9, "capture_sim", "Simulated capture for E-8"),
    ]);
    expect(items.map((i) => (i.type === "group" ? `group:${i.events.length}` : i.e.kind))).toEqual([
      "draw",
      "group:3",
      "voided",
      "voided",
      "voided",
      "capture_sim",
      "capture_sim",
    ]);
  });

  test("the SIMULATED prefix goes (the label says it), other messages keep their case", () => {
    expect(cleanEventMessage("SIMULATED capture for E-1 ($44.50).")).toBe("Capture for E-1 ($44.50).");
    expect(cleanEventMessage("Added 24 SIMULATED entrants (labelled)")).toBe("Added 24 simulated entrants (labelled)");
    expect(cleanEventMessage("drand round 23,456,789 published.")).toBe("drand round 23,456,789 published.");
  });

  test("trace status: success and PayPal error lines", () => {
    expect(traceStatus({ method: "POST", endpoint: "/x", httpStatus: 201, paypalStatus: "PARTIALLY_CAPTURED" })).toBe("201 · PARTIALLY_CAPTURED");
    expect(traceStatus({ method: "POST", endpoint: "/x", httpStatus: 422, paypalStatus: "AUTHORIZATION_VOIDED" })).toBe(
      "422 UNPROCESSABLE_ENTITY · AUTHORIZATION_VOIDED",
    );
  });
});

test.describe("seller console", () => {
  const entry = (id: string, over: Partial<SellerEntry> = {}): SellerEntry => ({
    id,
    publicId: id.toUpperCase(),
    source: "simulated",
    agentLabel: null,
    status: "held",
    displayName: null,
    name: null,
    address: null,
    holdCents: 4800,
    capturedCents: null,
    clusterId: null,
    note: null,
    ...over,
  });
  const cluster = (id: string, over: Partial<Cluster>): Cluster => ({
    id,
    kind: "household",
    status: "suggested",
    method: "rules",
    confidence: 0.9,
    evidence: [],
    explanation: "",
    memberIds: [],
    ...over,
  });

  test("address diff marks only the tokens missing from the normalized key", () => {
    const marked = (v: string) => addressDiff(v, "1200 HARBOR BLVD STE 4B 43215").filter((t) => t.differs).map((t) => t.text);
    expect(marked("1200 Harbor Blvd. Ste 4B 43215")).toEqual([]);
    expect(marked("1200 Harbour Boulevard #4B 43215")).toEqual(["Harbour", "Boulevard", "#4B"]);
    expect(addressDiff("1200  Harbor", "1200 HARBOR").map((t) => t.text).join("")).toBe("1200  Harbor");
  });

  test("pending copy counts suggestions and the accounts that would keep a ticket each", () => {
    const c = [
      cluster("a", { memberIds: ["1", "2", "3", "4", "5", "6"] }),
      cluster("b", { memberIds: ["7", "8"] }),
      cluster("c", { status: "confirmed", memberIds: ["9", "10"] }),
    ];
    expect(pendingCopy(c)).toBe("2 AI suggestions are still pending: 8 accounts would each keep a ticket. Review them first.");
    expect(pendingCopy([c[1]])).toBe("1 AI suggestion is still pending: 2 accounts would each keep a ticket. Review them first.");
  });

  test("draw preview: winners = min(units, holds), amount at price + actual shipping", () => {
    expect(drawPreview([entry("a"), entry("b"), entry("c"), entry("d", { status: "merged" })], 2, 4450)).toEqual({ eligible: 3, winners: 2, cents: 8900 });
    expect(drawPreview([entry("a")], 2, 4450)).toEqual({ eligible: 1, winners: 1, cents: 4450 });
    expect(drawPreview([], 2, 4450)).toEqual({ eligible: 0, winners: 0, cents: 0 });
  });

  test("swarm result counts scalper links and holds; clusters sort networks and AI first", () => {
    const bots = Array.from({ length: 12 }, (_, i) => entry(`b${i}`, { source: "agent", agentLabel: `scalper-bot-${i}`, status: "awaiting_person" }));
    expect(swarmResult([...bots, entry("wren", { source: "agent", agentLabel: "Wren", status: "held" })])).toEqual({ links: 12, holds: 0 });
    const sorted = sortClusters([
      cluster("hh-rules", {}),
      cluster("op-rules", { kind: "operator" }),
      cluster("hh-ai", { method: "ai" }),
      cluster("op-ai", { kind: "operator", method: "ai" }),
    ]);
    expect(sorted.map((c) => c.id)).toEqual(["op-ai", "op-rules", "hh-ai", "hh-rules"]);
  });

  test("model names and demo tracking numbers", () => {
    expect(prettyModel("primalabs-ai/MiMo-V2.6-Pro")).toBe("MiMo V2.6 Pro");
    expect(demoTracking(42)).toMatch(/^94001\d{17}$/);
  });
});
