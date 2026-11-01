// Pure ledger logic (no React): trace status line, simulated-row folding, message clean-up. Tested in e2e/ui-logic.spec.ts.
import type { EventRow, EventTrace } from "./api";

const HTTP_TEXT: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "RESOURCE_NOT_FOUND",
  409: "CONFLICT",
  422: "UNPROCESSABLE_ENTITY",
  429: "RATE_LIMIT_REACHED",
  500: "INTERNAL_SERVER_ERROR",
  503: "SERVICE_UNAVAILABLE",
};

/** "18:30:05": 24 h, so the time column never wraps or changes width. */
export const hms = (ts: number) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export const isSimEvent = (e: Pick<EventRow, "real" | "kind" | "message">) =>
  !e.real && (/_sim$/.test(e.kind) || e.kind === "simulated_crowd" || /^SIMULATED\b/.test(e.message) || /^Simulated\b/.test(e.message));

/** Older servers prefix simulated events with "SIMULATED"; the row's label says it now. */
export function cleanEventMessage(m: string): string {
  const stripped = m.replace(/^SIMULATED[:\s]+/, "");
  const t = stripped.replace(/^SANDBOX NEGATIVE TEST:\s*/, "Sandbox negative test: ").replace(/\bSIMULATED\b/g, "simulated");
  // "SIMULATED capture for …" → "Capture for …"; anything else keeps its case ("drand round …")
  return stripped !== m ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

const GROUP_LABEL: Record<string, (n: number) => string> = {
  void_sim: (n) => `${n} simulated holds released (labelled)`,
  capture_sim: (n) => `${n} simulated captures (labelled)`,
  shipped_sim: (n) => `${n} simulated shipments (labelled)`,
  refund_sim: (n) => `${n} simulated refunds (labelled)`,
};
export const groupLabel = (kind: string, n: number) => (GROUP_LABEL[kind] ?? ((k: number) => `${k} simulated events (labelled)`))(n);

export type TickerItem = { type: "one"; e: EventRow } | { type: "group"; kind: string; events: EventRow[] };

/** Consecutive simulated events of one kind (3 or more) fold into a single row. Real PayPal calls never fold. */
export function groupEvents(events: EventRow[]): TickerItem[] {
  const out: TickerItem[] = [];
  let i = 0;
  while (i < events.length) {
    const e = events[i];
    if (isSimEvent(e)) {
      let j = i;
      while (j + 1 < events.length && events[j + 1].kind === e.kind && isSimEvent(events[j + 1])) j++;
      if (j - i + 1 >= 3) {
        out.push({ type: "group", kind: e.kind, events: events.slice(i, j + 1) });
        i = j + 1;
        continue;
      }
    }
    out.push({ type: "one", e });
    i++;
  }
  return out;
}

/** "201 · PARTIALLY_CAPTURED", "422 UNPROCESSABLE_ENTITY · AUTHORIZATION_VOIDED" */
export function traceStatus(t: EventTrace): string {
  const failed = (t.httpStatus ?? 0) >= 400;
  const http = t.httpStatus != null ? `${t.httpStatus}${failed && HTTP_TEXT[t.httpStatus] ? ` ${HTTP_TEXT[t.httpStatus]}` : ""}` : null;
  return [http, t.paypalStatus].filter(Boolean).join(" · ");
}
