// Mocked v2 API shapes (research/CONTRACT.md) for the deterministic UI specs and the screenshot run.
// Nothing here talks to PayPal or the LLM; a running Paylet only serves the SPA.
import type { Page, Route } from "@playwright/test";

export const now = Date.now();
export const SLUG = "mock-drop";
export const KEY = "seller-key-mock-0000";

export const json = (page: Page, pattern: string | RegExp, body: unknown, status = 200) =>
  page.route(pattern, (r) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }));

export function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

export type DropStatus = "open" | "frozen" | "drawn" | "settled";

export function publicDrop(status: DropStatus = "open", over: Record<string, unknown> = {}) {
  const settled = status === "settled";
  return {
    id: "drop_mock",
    slug: SLUG,
    title: "Ember Glaze Mug",
    maker: "Juniper Street Ceramics",
    blurb: "Hand-thrown stoneware, ember glaze. Two made this week.",
    art: "ember",
    priceCents: 4100,
    shipHoldCents: 700,
    shipActualCents: 350,
    units: 2,
    closesAt: status === "open" ? now + 18 * 60_000 : now - 60_000,
    status,
    kind: "judge",
    seedHash: "5f0e4b1c9a7d3e2f8b6a4c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f",
    seed: status === "open" ? null : "9f2c1a7e44b0d3c8a1e5f6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091",
    frozenHash: status === "open" ? null : "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    frozenList: null,
    waitlistSize: 3,
    randomness:
      status === "open"
        ? null
        : {
            source: "drand-quicknet",
            round: 23_456_789,
            value: status === "frozen" ? null : "c3a1f0e2d9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a392",
            chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
            url: "https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/23456789",
          },
    finalSeed: null,
    pendingReviews: status === "open" ? 2 : 0,
    negativeTest: false,
    stats: {
      realOrders: 15,
      awaitingPerson: 12,
      holds: 2,
      duplicatesBlocked: 1,
      agents: 12,
      captured: settled ? 1 : 0,
      capturedCents: settled ? 4450 : 0,
      shippingReleasedCents: settled ? 350 : 0,
      voided: settled ? 1 : 0,
      refunded: 0,
      failedPayments: settled ? 1 : 0,
      merged: settled ? 5 : 0,
      simulated: 24,
      capturedSimulated: settled ? 1 : 0,
    },
    ...over,
  };
}

const NETWORK = [
  ["E-NW01", "Jordan Pike", "1200 Harbor Blvd", "Ste 4B"],
  ["E-NW02", "J. Pike", "1200 Harbour Blvd.", "Suite 4B"],
  ["E-NW03", "Jordyn Pike", "1200 Harbor Boulevard", "#4B"],
  ["E-NW04", "Pike Jordan", "1200 Harbor Blvd", "Ste 4-B"],
  ["E-NW05", "Jordan P.", "1200 HARBOR BLVD", "STE 4B"],
  ["E-NW06", "Jo Pike", "1200 Harbor Bl", "Unit 4B"],
] as const;

type Status = string;

export function sellerEntries(stage: "mid" | "settled" = "mid") {
  const settled = stage === "settled";
  const real = [
    {
      id: "ent_real_a",
      publicId: "E-7K2Q",
      source: "human",
      agentLabel: null,
      status: settled ? "captured" : "held",
      displayName: "Maya C.",
      name: "Maya Chen",
      address: { line1: "2140 Alder St", line2: "Apt 3", city: "Portland", state: "OR", zip: "97214" },
      holdCents: 4800,
      capturedCents: settled ? 4450 : null,
      refundedCents: null,
      authorization: "…7K2Q",
      clusterId: null,
      note: null,
      createdAt: now - 9 * 60_000,
      payerVerified: true,
      shipping: null,
    },
    {
      id: "ent_real_b",
      publicId: "E-AB12",
      source: "agent",
      agentLabel: "Wren (fan's assistant)",
      status: settled ? "voided" : "held",
      displayName: "Sam O.",
      name: "Sam Ortiz",
      address: { line1: "811 W 7th St", city: "Austin", state: "TX", zip: "78701" },
      holdCents: 4800,
      capturedCents: null,
      refundedCents: null,
      authorization: "…X9P1",
      clusterId: null,
      note: null,
      createdAt: now - 8 * 60_000,
      payerVerified: false,
      shipping: null,
    },
    {
      id: "ent_real_dup",
      publicId: "E-DUP1",
      source: "human",
      agentLabel: null,
      status: "duplicate",
      displayName: "Maya C.",
      name: "Maya Chen",
      address: null,
      holdCents: null,
      capturedCents: null,
      authorization: null,
      clusterId: null,
      note: "Same PayPal account as E-7K2Q",
      createdAt: now - 7 * 60_000,
      payerVerified: null,
      shipping: null,
    },
  ];
  const bots = Array.from({ length: 12 }, (_, i) => ({
    id: `ent_bot_${i}`,
    publicId: `E-B${String(i).padStart(3, "0")}`,
    source: "agent",
    agentLabel: `scalper-bot-${String(i + 1).padStart(2, "0")}`,
    status: settled ? "expired" : "awaiting_person",
    displayName: null,
    name: null,
    address: null,
    holdCents: null,
    capturedCents: null,
    authorization: null,
    clusterId: null,
    note: null,
    createdAt: now - 6 * 60_000,
    payerVerified: null,
    shipping: null,
  }));
  const sim = (id: string, publicId: string, name: string, line1: string, line2: string | undefined, zip: string, status: Status, cluster: string | null) => ({
    id,
    publicId,
    source: "simulated",
    agentLabel: null,
    status,
    displayName: name.split(" ")[0] + " " + name.split(" ").pop()![0] + ".",
    name,
    address: { line1, line2, city: zip === "43215" ? "Columbus" : "Dayton", state: "OH", zip },
    holdCents: 4800,
    capturedCents: status === "captured" ? 4450 : null,
    authorization: null,
    clusterId: cluster,
    note: null,
    createdAt: now - 5 * 60_000,
    payerVerified: null,
    shipping: null,
  });
  const network = NETWORK.map(([pid, name, l1, l2], i) =>
    sim(`ent_nw_${i}`, pid, name, l1, l2, "43215", settled ? (i === 0 ? "voided" : "merged") : "held", "cl_net"),
  );
  const household = [
    sim("ent_hh_0", "E-HH01", "Rosa Delgado", "88 Linden Ave", "Apt 2", "45402", settled ? "voided" : "held", "cl_hh"),
    sim("ent_hh_1", "E-HH02", "Luis Delgado", "88 Linden Avenue", "Apt 2", "45402", settled ? "merged" : "held", "cl_hh"),
  ];
  const crowd = Array.from({ length: 16 }, (_, i) =>
    sim(
      `ent_crowd_${i}`,
      `E-C${String(i).padStart(3, "0")}`,
      ["Ava Brooks", "Noah Kim", "Lena Fox", "Omar Haddad", "Ivy Chen", "Ben Ortiz", "Zoe Park", "Eli Stone"][i % 8],
      `${100 + i * 7} Elm St`,
      undefined,
      "45409",
      settled ? (i === 0 ? "captured" : i === 1 ? "capture_failed" : i < 4 ? "waitlist" : "voided") : "held",
      null,
    ),
  );
  return [...real, ...bots, ...network, ...household, ...crowd];
}

export function clusters(stage: "mid" | "settled" = "mid") {
  return [
    {
      id: "cl_hh",
      kind: "household",
      status: stage === "settled" ? "confirmed" : "suggested",
      method: "rules",
      confidence: 0.98,
      evidence: [
        { field: "address", detail: "same street address and apartment (Apt 2, 88 Linden Ave)" },
        { field: "surname", detail: "same surname: Delgado" },
      ],
      explanation: "Two PayPal accounts at the same apartment with the same surname: one household.",
      memberIds: ["ent_hh_0", "ent_hh_1"],
      normalizedKey: "88 LINDEN AVE APT 2 45402",
    },
    {
      id: "cl_net",
      kind: "operator",
      status: stage === "settled" ? "confirmed" : "suggested",
      method: "ai",
      confidence: 0.93,
      evidence: [
        { field: "address", detail: "6 spellings of one forwarding suite (1200 Harbor Blvd Ste 4B)" },
        { field: "names", detail: "name variants of one person: Jordan Pike" },
        { field: "timing", detail: "all six holds within 98 seconds" },
      ],
      explanation:
        "Six accounts share one forwarding suite written six ways, with variants of one name, and all held within 98 seconds: one reseller operation, not six fans.",
      memberIds: NETWORK.map((_, i) => `ent_nw_${i}`),
      normalizedKey: "1200 HARBOR BLVD STE 4B 43215",
    },
  ];
}

export const aiSummary = {
  model: "primalabs-ai/MiMo-V2.6-Pro",
  ranAt: (now - 2 * 60_000) as number | null,
  uncertainPairs: 6,
  linked: 1,
  keptApartCount: 4,
  keptApart: [
    { a: "E-C004", b: "E-C012", reason: "Apt 2 vs Apt 5 at 132 Elm St: different units, different surnames", confidence: 0.91 },
    { a: "E-C001", b: "E-C009", reason: "same first name, different streets and ZIPs", confidence: 0.88 },
    { a: "E-C003", b: "E-C011", reason: "neighbours on Elm St, no shared account details", confidence: 0.86 },
    { a: "E-C006", b: "E-C014", reason: "same surname, different cities", confidence: 0.82 },
  ],
  degraded: null as string | null,
};

let evId = 0;
const ev = (secAgo: number, kind: string, message: string, real: 0 | 1, trace?: Record<string, unknown>) => ({
  id: ++evId,
  ts: now - secAgo * 1000,
  kind,
  message,
  real,
  ...(trace ? { trace } : {}),
});

export function events(stage: "mid" | "settled" = "mid") {
  evId = 0;
  const list = [
    ev(600, "drop_opened", 'Drop opened: 2 × "Ember Glaze Mug" at $41.00. Seed commitment published.', 0),
    ev(560, "entry_requested", "Entry E-7K2Q requested by a person: PayPal order created, waiting for approval.", 1, {
      method: "POST",
      endpoint: "/v2/checkout/orders",
      httpStatus: 201,
      paypalStatus: "CREATED",
      id: "…3RG0",
      requestId: "create:…7K2Q",
      ms: 388,
    }),
    ev(540, "hold_placed", "Hold placed for E-7K2Q: $48.00 authorized (CREATED). Nothing charged yet.", 1, {
      method: "POST",
      endpoint: "/v2/checkout/orders/…3RG0/authorize",
      httpStatus: 201,
      paypalStatus: "COMPLETED",
      id: "…3RG0",
      requestId: "auth:…3RG0",
      ms: 912,
    }),
    ev(500, "duplicate_blocked", "Entry E-DUP1: same PayPal account as an existing entry → no hold placed.", 1, {
      method: "GET",
      endpoint: "/v2/checkout/orders/…9QZ4",
      httpStatus: 200,
      paypalStatus: "APPROVED",
      id: "…9QZ4",
      ms: 241,
    }),
    ev(420, "swarm_start", "Scalper swarm: 12 agents hitting the drop through MCP…", 0),
    ev(400, "swarm_done", "12 scalper agents → 12 PayPal approval links · 0 holds. A hold needs a person to approve in PayPal, and only one per PayPal account counts.", 0),
    ev(300, "simulated_crowd", "Added 24 SIMULATED entrants (labelled; no PayPal calls) to show allocation at scale.", 0),
    ev(200, "ai_review", "AI review: 6 uncertain pairs → 1 network linked, 4 pairs kept apart.", 0),
  ];
  if (stage === "settled") {
    list.push(
      ev(120, "cluster_confirmed", "Seller confirmed a reseller network of 6 PayPal accounts: one ticket.", 0),
      ev(100, "freeze", "List of 18 eligible entries frozen (hash a1b2c3d4e5f6…). Waiting for drand round 23,456,789.", 0),
      ev(96, "draw", "drand round 23,456,789 published. Seed revealed. 2 winners, 3 on the waitlist.", 0),
      ev(90, "captured", "Captured $44.50 for E-7K2Q (PARTIALLY_CAPTURED); $3.50 of the hold released.", 1, {
        method: "POST",
        endpoint: "/v2/payments/authorizations/…7K2Q/capture",
        httpStatus: 201,
        paypalStatus: "PARTIALLY_CAPTURED",
        id: "…7K2Q",
        requestId: "cap:…7K2Q:1",
        ms: 412,
      }),
      ev(88, "negative_test", "PayPal sandbox negative test (PayPal-Mock-Response: TRANSACTION_REFUSED) → 422 for E-C001. Voiding the live hold and passing the unit to the waitlist.", 1, {
        method: "POST",
        endpoint: "/v2/payments/authorizations/…M4RT/capture",
        httpStatus: 422,
        paypalStatus: "TRANSACTION_REFUSED",
        id: "…M4RT",
        requestId: "cap:…M4RT:1",
        debugId: "8f3a2c41d9e07",
        ms: 530,
      }),
      ev(86, "promoted", "Waitlist #1 E-C002 promoted: their hold already exists, capturing now.", 0),
      ev(84, "webhook", "Webhook PAYMENT.CAPTURE.COMPLETED for E-7K2Q.", 1, {
        method: "POST",
        endpoint: "/v1/notifications/verify-webhook-signature",
        event: "PAYMENT.CAPTURE.COMPLETED",
        id: "WH-…9F2A",
        verified: true,
        httpStatus: 200,
        paypalStatus: "SUCCESS",
      }),
      ev(82, "voided", "Hold released for E-AB12 (not selected) — voided, never charged.", 1, {
        method: "POST",
        endpoint: "/v2/payments/authorizations/…X9P1/void",
        httpStatus: 204,
        paypalStatus: "VOIDED",
        id: "…X9P1",
        requestId: "void:…X9P1",
        ms: 301,
      }),
      ...Array.from({ length: 14 }, (_, i) => ev(80 - i, "void_sim", `SIMULATED hold release for E-C${String(i + 4).padStart(3, "0")} (not selected).`, 0)),
      ev(60, "settled", "Settled: 2 unit(s) paid. Every other hold released. Nobody who lost was charged.", 0),
    );
  }
  return list;
}

export const report = {
  units: 2,
  unitsToDistinctPayers: 2,
  capturedCents: 8900,
  shippingReleasedCents: 700,
  holdsVoided: 21,
  chargedToLosersCents: 0,
  failedPayments: 1,
  waitlistRecoverySeconds: 3,
  agentRequests: 13,
  agentHoldsWithoutPerson: 0,
  networkAccounts: 6,
  networkTickets: 1,
  sameAccountDuplicates: 1,
  payerVerified: 1,
  real: true,
};

export interface ConsoleState {
  status: DropStatus;
  stage: "mid" | "settled";
  ai?: typeof aiSummary;
  negativeTest?: boolean;
  /** entries/clusters override (e.g. empty drop) */
  entries?: unknown[];
  clusters?: unknown[];
  events?: unknown[];
}

/**
 * Mocks every endpoint the seller console, the fan page, /verify and /judge read for SLUG. `state` is read on every
 * request, so a test can move the drop forward (state.status = "frozen" …) and the UI follows on its next poll.
 */
export async function mockDrop(page: Page, state: ConsoleState, onPost?: (path: string, body: unknown, route: Route) => boolean | Promise<boolean>) {
  const drop = () => publicDrop(state.status, { negativeTest: !!state.negativeTest, pendingReviews: (state.clusters ?? clusters(state.stage)).filter((c: any) => c.status === "suggested").length });
  await page.route(`**/api/drops/${SLUG}`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(drop()) }));
  await page.route(`**/api/drops/${SLUG}/events*`, (r) => {
    const after = Number(new URL(r.request().url()).searchParams.get("after") ?? 0);
    const all = (state.events ?? events(state.stage)) as { id: number }[];
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ events: all.filter((e) => e.id > after) }) });
  });
  await page.route(`**/api/drops/${SLUG}/report`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(report) }));
  await page.route(`**/api/seller/${SLUG}`, (r) => {
    if (r.request().headers()["x-seller-key"] !== KEY)
      return r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "seller_key_required" }) });
    return r.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        drop: drop(),
        entries: state.entries ?? sellerEntries(state.stage),
        clusters: state.clusters ?? clusters(state.stage),
        ai: state.ai ?? aiSummary,
        usage: { today: 14, dailyCap: 600, model: "primalabs-ai/MiMo-V2.6-Pro" },
      }),
    });
  });
  await page.route(`**/api/seller/${SLUG}/**`, async (r) => {
    const path = new URL(r.request().url()).pathname.replace(`/api/seller/${SLUG}/`, "");
    const body = r.request().postDataJSON?.() ?? null;
    if (onPost && (await onPost(path, body, r))) return;
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
}
