import { describe, expect, it } from "vitest";
import { canonicalList, computeDraw, sha256Hex } from "../src/shared/draw";
import { formatUsd, fromPayPal, toPayPal } from "../src/shared/money";
import { normalizeAddress, normalizeEmail, normalizeName } from "../src/server/er/normalize";
import { components, prepare, scorePair } from "../src/server/er/rules";

describe("verifiable draw", () => {
  const ids = ["E-AAAA", "E-BBBB", "E-CCCC", "E-DDDD", "E-EEEE", "E-FFFF"];
  it("is deterministic for a given seed and independent of input order", async () => {
    const a = await computeDraw("seed-1", ids, 2, 2);
    const b = await computeDraw("seed-1", [...ids].reverse(), 2, 2);
    expect(a.winners).toEqual(b.winners);
    expect(a.waitlist).toEqual(b.waitlist);
    expect(a.winners).toHaveLength(2);
    expect(a.waitlist).toHaveLength(2);
    expect(new Set([...a.winners, ...a.waitlist]).size).toBe(4);
  });
  it("changes with the seed", async () => {
    const a = await computeDraw("seed-1", ids, 3);
    const b = await computeDraw("seed-2", ids, 3);
    expect(a.ranking.map((r) => r.publicId)).not.toEqual(b.ranking.map((r) => r.publicId));
  });
  it("commitments are plain SHA-256 so anyone can check them", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(canonicalList(["b", "a"])).toBe("a\nb");
  });
  it("never selects duplicates even if ids repeat", async () => {
    const r = await computeDraw("s", ["E-1", "E-1", "E-2"], 5);
    expect(r.winners.sort()).toEqual(["E-1", "E-2"]);
  });
});

describe("money", () => {
  it("round-trips cents and PayPal decimal strings", () => {
    expect(toPayPal(7700)).toBe("77.00");
    expect(toPayPal(5)).toBe("0.05");
    expect(fromPayPal("72.5")).toBe(7250);
    expect(fromPayPal("0.05")).toBe(5);
    expect(formatUsd(6500)).toBe("$65.00");
    expect(() => toPayPal(1.5)).toThrow();
  });
});

describe("normalisation", () => {
  it("treats forwarder suite spellings as the same unit", () => {
    const forms = [
      { line1: "1200 Harbor Blvd", line2: "Ste 4B" },
      { line1: "1200 Harbor Blvd #4-B" },
      { line1: "1200 Harbor Boulevard", line2: "Suite 4B" },
      { line1: "1200 Harbor Blvd", line2: "Unit 4B c/o ParcelHop" },
      { line1: "1200 Harbor Blvd.", line2: "STE 4b" },
    ].map((a) => normalizeAddress({ ...a, zip: "97201-1234" }));
    for (const f of forms) {
      expect(f.street).toBe("1200 HARBOR BLVD");
      expect(f.unit).toBe("4B");
      expect(f.zip5).toBe("97201");
    }
    expect(forms[3].careOf).toBe("PARCELHOP");
  });
  it("canonicalises mailbox aliases", () => {
    expect(normalizeEmail("Maya.Tanaka+drop@gmail.com")).toBe("mayatanaka@gmail.com");
    expect(normalizeEmail("maya.tanaka@googlemail.com")).toBe("mayatanaka@gmail.com");
    expect(normalizeEmail("a.b+x@example.com")).toBe("a.b@example.com");
  });
  it("maps nicknames", () => {
    expect(normalizeName("Bob Smith")).toEqual(["robert", "smith"]);
  });
});

describe("rule scoring", () => {
  const p = (id: string, name: string, line1: string, line2: string | undefined, zip: string, email?: string) => prepare([{ id, name, email, address: { line1, line2, zip } }])[0];
  it("links the same suite with different names", () => {
    const s = scorePair(p("a", "Maya Tanaka", "1200 Airport Rd", "Ste 4B", "31401"), p("b", "Omar Haddad", "1200 Airport Road", "#4-B", "31401"));
    expect(s.band).toBe("link");
  });
  it("does not link neighbours in different apartments", () => {
    const s = scorePair(p("a", "Iris Chen", "88 Cedar St", "Apt 2A", "97205"), p("b", "Noah Silva", "88 Cedar St", "Apt 5C", "97205"));
    expect(s.band).not.toBe("link");
  });
  it("does not link namesakes in different cities", () => {
    const s = scorePair(p("a", "Sam Rossi", "10 Elm Ct", undefined, "53703"), p("b", "Sam Rossi", "771 Orchard Dr", undefined, "85701"));
    expect(s.band).toBe("none");
  });
  it("links a shared mailbox regardless of address", () => {
    const s = scorePair(p("a", "A", "1 X St", undefined, "11111", "zo.e+1@gmail.com"), p("b", "B", "2 Y St", undefined, "22222", "zoe@gmail.com"));
    expect(s.score).toBe(1);
  });
  it("builds connected components", () => {
    expect(components(["a", "b", "c", "d"], [["a", "b"], ["b", "c"]]).map((g) => g.sort())).toEqual([["a", "b", "c"]]);
  });
});
