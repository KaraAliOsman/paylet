// Pure UI logic (no browser): the hold timeline model and the /verify reconciliation.
import { expect, test } from "@playwright/test";
import { holdSteps, approvalExpiresAt } from "../src/web/timeline";
import { reconcile } from "../src/web/verify-logic";

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
