// Deterministic normalisation used by entity resolution (and by the "rules" eval baseline).

export interface RawAddress {
  line1: string;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
}

export interface Identity {
  id: string;
  name: string;
  email?: string | null;
  address: RawAddress;
  /** Unix ms when the entry arrived (burst detection). */
  ts?: number;
  /** "human" | "agent" | "simulated" */
  source?: string;
  agentLabel?: string | null;
}

export interface NormAddress {
  street: string; // "1200 HARBOR BLVD"
  unit: string; // "4B" or ""
  zip5: string;
  city: string;
  state: string;
  careOf: string; // "C/O" / "ATTN" name if present
}

const SUFFIX: Record<string, string> = {
  STREET: "ST", STR: "ST", AVENUE: "AVE", AV: "AVE", BOULEVARD: "BLVD", ROAD: "RD", DRIVE: "DR", LANE: "LN",
  COURT: "CT", PLACE: "PL", TERRACE: "TER", PARKWAY: "PKWY", HIGHWAY: "HWY", CIRCLE: "CIR", SQUARE: "SQ",
  NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W", NORTHEAST: "NE", NORTHWEST: "NW", SOUTHEAST: "SE", SOUTHWEST: "SW",
};
const UNIT_WORDS = "APARTMENT|APT|SUITE|STE|UNIT|ROOM|RM|FLOOR|FL|BLDG|BUILDING|PMB|BOX|#|NO";

function clean(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[.,;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripCareOf(s: string): { rest: string; careOf: string } {
  const m = s.match(/\b(C\s*\/\s*O|CARE OF|ATTN:?|ATTENTION)\s+(.+)$/);
  if (!m) return { rest: s, careOf: "" };
  return { rest: s.slice(0, m.index).trim(), careOf: m[2].trim() };
}

export function normalizeAddress(a: RawAddress): NormAddress {
  let l1 = clean(a.line1);
  let l2 = clean(a.line2);
  const c1 = stripCareOf(l1);
  const c2 = stripCareOf(l2);
  l1 = c1.rest;
  l2 = c2.rest;
  const careOf = c1.careOf || c2.careOf;

  let unit = "";
  const unitRe = new RegExp(`(?:\\b(?:${UNIT_WORDS})\\b|#)\\s*#?\\s*([A-Z0-9][A-Z0-9-]*)`);
  for (const part of [l1, l2]) {
    const m = part.match(unitRe);
    if (m && !unit) unit = m[1].replace(/-/g, "");
  }
  // Remove the unit fragment from the street line.
  l1 = l1.replace(new RegExp(`(?:\\b(?:${UNIT_WORDS})\\b|#)\\s*#?\\s*[A-Z0-9][A-Z0-9-]*`, "g"), " ").trim();
  if (!unit && /^[A-Z0-9-]{1,8}$/.test(l2)) unit = l2.replace(/-/g, "");

  const street = l1
    .split(" ")
    .filter(Boolean)
    .map((w) => SUFFIX[w] ?? w)
    .join(" ");

  return {
    street,
    unit,
    zip5: clean(a.zip).replace(/[^0-9]/g, "").slice(0, 5),
    city: clean(a.city),
    state: clean(a.state),
    careOf,
  };
}

export function normalizeEmail(email: string | null | undefined): string {
  if (!email) return "";
  const [localRaw, domainRaw = ""] = email.trim().toLowerCase().split("@");
  const domain = domainRaw === "googlemail.com" ? "gmail.com" : domainRaw;
  let local = localRaw.split("+")[0];
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

const NICK: Record<string, string> = {
  bob: "robert", rob: "robert", bobby: "robert", bill: "william", will: "william", liz: "elizabeth", beth: "elizabeth",
  kate: "katherine", katie: "katherine", kathy: "katherine", mike: "michael", jim: "james", jimmy: "james",
  jen: "jennifer", jenny: "jennifer", tom: "thomas", tony: "anthony", dan: "daniel", danny: "daniel", alex: "alexander",
  sam: "samuel", chris: "christopher", nick: "nicholas", matt: "matthew", dave: "david", steve: "steven", joe: "joseph",
  sasha: "alexander", pete: "peter", andy: "andrew", ben: "benjamin", meg: "margaret", peggy: "margaret",
};

export function normalizeName(name: string | null | undefined): string[] {
  return clean(name)
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .map((t) => NICK[t] ?? t);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

export function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length, 1);
}
