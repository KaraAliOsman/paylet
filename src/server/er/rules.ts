// Deterministic candidate generation + scoring. The LLM only sees the pairs this marks "uncertain".
import { normalizeAddress, normalizeEmail, normalizeName, similarity, type Identity, type NormAddress } from "./normalize";

export interface Signal {
  field: string;
  detail: string;
  weight: number;
}

export interface PairScore {
  a: string;
  b: string;
  score: number;
  signals: Signal[];
  band: "link" | "uncertain" | "none";
}

export interface Prepared {
  id: string;
  raw: Identity;
  addr: NormAddress;
  email: string;
  name: string[];
}

export function prepare(list: Identity[]): Prepared[] {
  return list.map((raw) => ({
    id: raw.id,
    raw,
    addr: normalizeAddress(raw.address),
    email: normalizeEmail(raw.email),
    name: normalizeName(raw.name),
  }));
}

function nameSim(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  // best token alignment score, order-insensitive (handles "Kim Dana" vs "Dana Kim")
  const score = (x: string[], y: string[]) =>
    x.reduce((s, t) => s + Math.max(...y.map((u) => similarity(t, u))), 0) / x.length;
  return Math.min(score(a, b), score(b, a));
}

export const LINK_THRESHOLD = 0.85;
export const UNCERTAIN_THRESHOLD = 0.35;

export function scorePair(p: Prepared, q: Prepared): PairScore {
  const signals: Signal[] = [];
  let score = 0;

  if (p.email && p.email === q.email) {
    signals.push({ field: "email", detail: "same mailbox after alias normalisation", weight: 1 });
    score = Math.max(score, 1);
  }

  const sameZip = p.addr.zip5 && p.addr.zip5 === q.addr.zip5;
  const streetSim = similarity(p.addr.street, q.addr.street);
  const sameStreet = sameZip && streetSim >= 0.88;
  const sameUnit = p.addr.unit === q.addr.unit;
  const ns = nameSim(p.name, q.name);
  const sameSurname = p.name.length && q.name.length && similarity(p.name[p.name.length - 1], q.name[q.name.length - 1]) >= 0.8;

  if (sameStreet && sameUnit) {
    const w = p.addr.unit ? 0.9 : 0.75; // single-family homes are weaker evidence than an exact suite
    signals.push({ field: "address", detail: `same street + unit "${p.addr.unit || "—"}" in ${p.addr.zip5}`, weight: w });
    score = Math.max(score, w);
  } else if (sameStreet) {
    signals.push({ field: "address", detail: `same building ${p.addr.street} ${p.addr.zip5}, different unit (${p.addr.unit || "—"} vs ${q.addr.unit || "—"})`, weight: 0.4 });
    score = Math.max(score, 0.4);
  }

  if (p.addr.careOf || q.addr.careOf) {
    const co = p.addr.careOf || q.addr.careOf;
    if (sameStreet) {
      signals.push({ field: "care_of", detail: `c/o "${co}" routing at a shared address`, weight: 0.15 });
      score = Math.min(1, score + 0.15);
    }
  }

  if (ns >= 0.85 && sameZip) {
    signals.push({ field: "name", detail: `near-identical name (${(ns * 100) | 0}%) in same ZIP`, weight: 0.6 });
    score = Math.max(score, sameStreet ? 0.95 : 0.6);
  } else if (sameSurname && sameStreet) {
    signals.push({ field: "name", detail: "same surname at the same street", weight: 0.2 });
    score = Math.min(1, score + 0.2);
  }

  const dt = Math.abs((p.raw.ts ?? 0) - (q.raw.ts ?? 0));
  if (p.raw.ts && q.raw.ts && dt < 15_000 && p.raw.source === "agent" && q.raw.source === "agent") {
    signals.push({ field: "timing", detail: `agent entries ${Math.round(dt / 1000)}s apart`, weight: 0.1 });
    score = Math.min(1, score + 0.1);
  }

  const band = score >= LINK_THRESHOLD ? "link" : score >= UNCERTAIN_THRESHOLD ? "uncertain" : "none";
  return { a: p.id, b: q.id, score: Math.round(score * 100) / 100, signals, band };
}

export function allPairs(prepared: Prepared[]): PairScore[] {
  const out: PairScore[] = [];
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const s = scorePair(prepared[i], prepared[j]);
      if (s.band !== "none") out.push(s);
    }
  }
  return out;
}

/** Union-find over linked pairs → groups of ids (only groups with ≥2 members). */
export function components(ids: string[], links: [string, string][]): string[][] {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  for (const [a, b] of links) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const r = find(id);
    groups.set(r, [...(groups.get(r) ?? []), id]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Baseline 1: exact string equality on raw address or raw email. */
export function exactBaseline(list: Identity[]): [string, string][] {
  const key = (i: Identity) =>
    `${(i.address.line1 ?? "").trim().toLowerCase()}|${(i.address.line2 ?? "").trim().toLowerCase()}|${(i.address.zip ?? "").trim()}`;
  const links: [string, string][] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (key(a) === key(b) || (a.email && b.email && a.email.trim().toLowerCase() === b.email.trim().toLowerCase())) {
        links.push([a.id, b.id]);
      }
    }
  }
  return links;
}

/** Baseline 2: normalisation + rules, deciding uncertain pairs with a fixed threshold (no LLM). */
export function rulesBaseline(list: Identity[], threshold = 0.6): [string, string][] {
  return allPairs(prepare(list))
    .filter((p) => p.score >= threshold)
    .map((p) => [p.a, p.b] as [string, string]);
}
