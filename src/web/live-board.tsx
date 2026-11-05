import { useEffect, useMemo, useState } from "react";
import { api, type EventRow } from "./api";
import { ArrowIcon } from "./icons";
import { Link } from "./router";

/**
 * The home hero's product shot: the proof drop's real ledger, replayed line by line like a departures board.
 * Every row is a real event from a finished PayPal sandbox run (timestamps, endpoints and statuses come from
 * /api/drops/<proof>/events); the twelve scalper-agent orders are folded into one row.
 */
type Who = "agent" | "person" | "paylet" | "paypal";
interface Row {
  ts: number;
  who: Who;
  whoLabel: string;
  what: string;
  call?: string;
  status: string;
  tone: "hold" | "none" | "ok" | "bad" | "info";
}

const short = (endpoint: string) => endpoint.replace(/\/v2\/checkout\/orders/, "/orders").replace(/\/v2\/payments\/authorizations/, "/authorizations");

function rowsFrom(events: EventRow[]): Row[] {
  const out: Row[] = [];
  let swarm: Row | null = null;
  let swarmN = 0;
  let checked = false;
  for (const e of events) {
    const t = e.trace;
    const call = t ? `${t.method} ${short(t.endpoint)}` : undefined;
    switch (e.kind) {
      case "drop_opened":
        out.push({ ts: e.ts, who: "paylet", whoLabel: "Paylet", what: "Drop opens · 1 unit · seed hash published", status: "OPEN", tone: "info" });
        break;
      case "order_created":
        if (/scalper-bot/.test(e.message)) {
          swarmN++;
          if (!swarm) {
            swarm = { ts: e.ts, who: "agent", whoLabel: "12 agents", what: "", call, status: "NO HOLD", tone: "none" };
            out.push(swarm);
          }
          swarm.what = `${swarmN} scalper agents request entries over MCP`;
        } else if (/Agent/.test(e.message)) {
          out.push({ ts: e.ts, who: "agent", whoLabel: "Fan's agent", what: "Requests an entry, gets a PayPal link, stops", call, status: "LINK", tone: "info" });
        }
        break;
      case "hold_placed":
        out.push({ ts: e.ts, who: "person", whoLabel: "Person", what: "Approves in PayPal · $48.00 authorized", call, status: "HOLD $48.00", tone: "hold" });
        break;
      case "duplicate_blocked":
        out.push({ ts: e.ts, who: "person", whoLabel: "Same payer", what: "Second approval from the same PayPal account", call: "GET /orders/{id} → payer_id", status: "BLOCKED", tone: "bad" });
        break;
      case "randomness":
        out.push({ ts: e.ts, who: "paylet", whoLabel: "Paylet", what: "List frozen · public drand round picks the winner", status: "DRAW", tone: "info" });
        break;
      case "captured":
        out.push({ ts: e.ts, who: "paypal", whoLabel: "PayPal", what: "Winner pays price + real shipping · $3.50 released", call, status: "$44.50 CAPTURED", tone: "ok" });
        break;
      case "settled":
        out.push({ ts: e.ts, who: "paylet", whoLabel: "Paylet", what: "Settled · charged to everyone who lost", status: "$0.00", tone: "ok" });
        break;
      case "paypal_check":
        if (!checked) out.push({ ts: e.ts, who: "paypal", whoLabel: "PayPal", what: "Every hold re-checked against PayPal", call: "GET /authorizations/{id}", status: "MATCH", tone: "ok" });
        checked = true;
        break;
    }
  }
  return out;
}

const STEP_MS = 900;
const HOLD_MS = 5200;

export function LiveBoard({ slug }: { slug: string | null }) {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!slug) return;
    void api<{ events: EventRow[] }>(`/api/drops/${slug}/events`)
      .then((r) => setEvents(r.events))
      .catch(() => setEvents([]));
  }, [slug]);
  const rows = useMemo(() => (events ? rowsFrom(events) : []), [events]);
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    if (!rows.length) return;
    if (reduced) {
      setShown(rows.length);
      return;
    }
    const t = setTimeout(() => setShown((n) => (n >= rows.length ? 0 : n + 1)), shown >= rows.length ? HOLD_MS : shown === 0 ? 500 : STEP_MS);
    return () => clearTimeout(t);
  }, [rows.length, shown, reduced]);

  const t0 = rows[0]?.ts ?? 0;
  const clock = (ts: number) => {
    const s = Math.max(0, Math.round((ts - t0) / 1000));
    return `+${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };

  return (
    <figure className="board" aria-label="Replay of the proof drop's real PayPal ledger">
      <figcaption className="board-head">
        <span className="board-title">
          Proof drop · real PayPal sandbox ledger
        </span>
        {slug && (
          <Link href={`/verify/${slug}`} className="board-link">
            Verify <ArrowIcon size={13} />
          </Link>
        )}
      </figcaption>
      <div className={`board-prog ${shown === 0 ? "is-reset" : ""}`} style={{ transform: `scaleX(${rows.length ? shown / rows.length : 0})` }} aria-hidden="true" />
      <ol className="board-rows">
        {rows.length === 0 && <li className="board-empty">{events === null && slug ? "Loading the ledger…" : "The proof drop's ledger shows up here."}</li>}
        {rows.map((r, i) => (
          <li key={i} className={`board-row ${i < shown ? "on" : ""} ${i === shown - 1 ? "now" : ""}`}>
            <time>{clock(r.ts)}</time>
            <span className={`who who-${r.who}`}>{r.whoLabel}</span>
            <span className="what">
              {r.what}
              {r.call && <code>{r.call}</code>}
            </span>
            <span className={`st st-${r.tone}`}>{r.status}</span>
          </li>
        ))}
      </ol>
    </figure>
  );
}
