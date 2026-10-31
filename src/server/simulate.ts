// Synthetic entrants. Used for (a) the clearly-labelled "simulated crowd" in a drop and (b) the eval dataset.
// Nothing here ever touches PayPal.
import type { Identity } from "./er/normalize";

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Maya", "Jordan", "Priya", "Leo", "Ana", "Sam", "Noah", "Iris", "Kenji", "Lucia", "Omar", "Grace", "Theo", "Zoe", "Ravi", "Elena", "Marcus", "Hana", "Diego", "Nora", "Felix", "Amara", "Jonah", "Mei", "Tobias", "Sofia", "Kai", "Lena", "Arjun", "Clara"];
const LAST = ["Okafor", "Lindqvist", "Ramirez", "Chen", "Haddad", "Novak", "Brennan", "Kowalski", "Tanaka", "Moreau", "Silva", "Petrov", "Nguyen", "Abara", "Fischer", "Rossi", "Kaur", "Delgado", "Walsh", "Hoang"];
const STREETS = ["Maple Ave", "Cedar St", "Linden Blvd", "Harbor Rd", "Juniper Ln", "Quarry St", "Elm Ct", "Orchard Dr", "Bayview Ter", "Willow Way", "Mission St", "Granite Pl"];
const CITIES: [string, string, string][] = [
  ["Portland", "OR", "97205"], ["Austin", "TX", "78704"], ["Columbus", "OH", "43215"], ["Denver", "CO", "80203"], ["Raleigh", "NC", "27601"],
  ["Madison", "WI", "53703"], ["Tucson", "AZ", "85701"], ["Boise", "ID", "83702"], ["Richmond", "VA", "23219"], ["Spokane", "WA", "99201"],
  ["Albany", "NY", "12207"], ["Omaha", "NE", "68102"], ["Savannah", "GA", "31401"], ["Burlington", "VT", "05401"],
];

export interface LabeledIdentity extends Identity {
  /** Ground-truth group: entries with the same group should be collapsed into one allocation. */
  group: string;
  kind: "fan" | "household" | "reshipper_network" | "neighbor" | "namesake";
}

function pick<T>(r: () => number, a: T[]): T {
  return a[Math.floor(r() * a.length)];
}

function fan(r: () => number, i: number, tag: string): LabeledIdentity {
  const first = pick(r, FIRST);
  const last = pick(r, LAST);
  const [city, state, zip] = pick(r, CITIES);
  const num = 100 + Math.floor(r() * 8800);
  return {
    id: `${tag}-fan-${i}`,
    name: `${first} ${last}`,
    email: `${first}.${last}${Math.floor(r() * 90)}@example.com`.toLowerCase(),
    address: { line1: `${num} ${pick(r, STREETS)}`, city, state, zip, country: "US" },
    group: `${tag}-fan-${i}`,
    kind: "fan",
  };
}

/** One scalper operation spread across several PayPal accounts that all ship to one freight-forwarder suite. */
function reshipperNetwork(r: () => number, n: number, tag: string, idx: number): LabeledIdentity[] {
  const base = { num: 1200 + idx * 37, street: pick(r, ["Harbor Blvd", "Commerce Way", "Logistics Pkwy", "Airport Rd"]), suite: `${4 + idx}B`, city: pick(r, CITIES) };
  const [city, state, zip] = base.city;
  const forms = [
    { line1: `${base.num} ${base.street}`, line2: `Ste ${base.suite}` },
    { line1: `${base.num} ${base.street} #${base.suite.replace("B", "-B")}`, line2: "" },
    { line1: `${base.num} ${base.street.replace("Blvd", "Boulevard").replace("Rd", "Road").replace("Pkwy", "Parkway")}`, line2: `Suite ${base.suite}` },
    { line1: `${base.num} ${base.street}`, line2: `Unit ${base.suite} c/o ${pick(r, ["ShipBridge", "ParcelHop", "FwdBox"])}` },
    { line1: `${base.num} ${base.street}`, line2: `STE ${base.suite.toLowerCase()}` },
    { line1: `${base.num} ${base.street}`, line2: `Attn ${pick(r, FIRST)} - Ste ${base.suite}` },
  ];
  const operator = { first: pick(r, FIRST), last: pick(r, LAST) };
  const names = [
    `${operator.first} ${operator.last}`,
    `${operator.last} ${operator.first}`,
    `${operator.first[0]}. ${operator.last}`,
    `${pick(r, FIRST)} ${operator.last}`,
    `${pick(r, FIRST)} ${pick(r, LAST)}`,
    `${operator.first} ${pick(r, LAST)}`,
  ];
  const t0 = 1_700_000_000_000 + idx * 1_000_000;
  return Array.from({ length: n }, (_, k) => {
    const f = forms[k % forms.length];
    return {
      id: `${tag}-net${idx}-${k}`,
      name: names[k % names.length],
      // only the first two accounts reuse one mailbox (gmail dot / +tag aliasing); the rest use distinct mailboxes
      email:
        k === 0
          ? `${operator.first}${operator.last}+drop@gmail.com`.toLowerCase()
          : k === 1
            ? `${operator.first}.${operator.last}@googlemail.com`.toLowerCase()
            : `${pick(r, FIRST)}${100 + Math.floor(r() * 899)}@mailbox.example`.toLowerCase(),
      address: { line1: f.line1, line2: f.line2, city, state, zip, country: "US" },
      ts: t0 + k * 2000,
      source: "agent",
      group: `${tag}-net${idx}`,
      kind: "reshipper_network" as const,
    };
  });
}

/** Two or three people in one home (same street address, no unit), different PayPal accounts. */
function household(r: () => number, tag: string, idx: number): LabeledIdentity[] {
  const last = pick(r, LAST);
  const [city, state, zip] = pick(r, CITIES);
  const num = 200 + Math.floor(r() * 5000);
  const street = pick(r, STREETS);
  const n = 2 + Math.floor(r() * 2);
  return Array.from({ length: n }, (_, k) => ({
    id: `${tag}-hh${idx}-${k}`,
    name: `${pick(r, FIRST)} ${last}`,
    email: `${last.toLowerCase()}.${tag}${idx}.m${k}@example.net`,
    address: { line1: k === 1 ? `${num} ${street.replace(" St", " Street").replace(" Ave", " Avenue")}` : `${num} ${street}`, city, state, zip, country: "US" },
    group: `${tag}-hh${idx}`,
    kind: "household" as const,
  }));
}

/** Hard negatives: same building, different apartments, unrelated people. */
function neighbors(r: () => number, tag: string, idx: number): LabeledIdentity[] {
  const [city, state, zip] = pick(r, CITIES);
  const num = 300 + Math.floor(r() * 3000);
  const street = pick(r, STREETS);
  return [0, 1].map((k) => ({
    id: `${tag}-nb${idx}-${k}`,
    name: `${pick(r, FIRST)} ${pick(r, LAST)}`,
    email: `n${idx}${k}${Math.floor(r() * 999)}@example.org`,
    address: { line1: `${num} ${street}`, line2: `Apt ${k === 0 ? "2" : "5"}${pick(r, ["A", "C", "F"])}`, city, state, zip, country: "US" },
    group: `${tag}-nb${idx}-${k}`,
    kind: "neighbor" as const,
  }));
}

/** Hard negatives: identical common name, different cities. */
function namesakes(r: () => number, tag: string, idx: number): LabeledIdentity[] {
  const name = `${pick(r, FIRST)} ${pick(r, LAST)}`;
  return [0, 1].map((k) => {
    const [city, state, zip] = CITIES[(idx * 3 + k * 5) % CITIES.length];
    return {
      id: `${tag}-ns${idx}-${k}`,
      name,
      email: `${name.split(" ")[0].toLowerCase()}${k}${idx}@example.com`,
      address: { line1: `${100 + Math.floor(r() * 9000)} ${pick(r, STREETS)}`, city, state, zip, country: "US" },
      group: `${tag}-ns${idx}-${k}`,
      kind: "namesake" as const,
    };
  });
}

export function syntheticCrowd(seed: number, opts: { fans: number; networks: number; netSize: number; households: number; neighbors: number; namesakes: number }, tag = "s"): LabeledIdentity[] {
  const r = rng(seed);
  const out: LabeledIdentity[] = [];
  for (let i = 0; i < opts.fans; i++) out.push(fan(r, i, tag));
  for (let i = 0; i < opts.networks; i++) out.push(...reshipperNetwork(r, opts.netSize, tag, i));
  for (let i = 0; i < opts.households; i++) out.push(...household(r, tag, i));
  for (let i = 0; i < opts.neighbors; i++) out.push(...neighbors(r, tag, i));
  for (let i = 0; i < opts.namesakes; i++) out.push(...namesakes(r, tag, i));
  // shuffle deterministically
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
