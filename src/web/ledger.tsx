// The drop's ledger (P1-01 PayPal trace chips, P1-02 simulated rows folded, P2-15 no jumps + role=log).
import { useEffect, useRef, useState } from "react";
import { api, type EventRow, type EventTrace } from "./api";
import { cleanEventMessage, groupEvents, groupLabel, hms, isSimEvent, traceStatus } from "./ledger-logic";

export { cleanEventMessage, groupEvents, hms } from "./ledger-logic";

const shortDebug = (d: string) => (d.length > 8 ? `${d.slice(0, 6)}…` : d);

/** One PayPal call (or webhook) under a ledger line. The status chip always shows; endpoint and ids only with the trace on. */
export function TraceChip({ t, full }: { t: EventTrace; full: boolean }) {
  const failed = (t.httpStatus ?? 0) >= 400;
  if (t.event) {
    return (
      <div className="pp-trace">
        <span className={`pp-chip ${t.verified === false ? "pp-chip-bad" : "pp-chip-ok"}`}>
          Webhook <b>{t.event}</b>
          {full && t.id ? <> · event {t.id}</> : null}
          {t.verified === true ? <> · signature verified ✓</> : t.verified === false ? <> · signature NOT verified</> : null}
        </span>
      </div>
    );
  }
  const status = traceStatus(t);
  if (!full)
    return status ? (
      <div className="pp-trace">
        <span className={`pp-chip ${failed ? "pp-chip-bad" : "pp-chip-ok"}`}>{status}</span>
      </div>
    ) : null;
  const more = [t.requestId ? `PayPal-Request-Id ${t.requestId}` : null, t.ms != null ? `${t.ms} ms` : null, t.debugId ? `debug_id ${t.debugId}` : null].filter(
    Boolean,
  );
  const summary = (
    <>
      <code>
        {t.method} {t.endpoint}
      </code>
      {status && (
        <span className={failed ? "pp-bad" : "pp-ok"}>
          {" → "}
          {status}
          {failed && t.debugId ? ` · debug_id ${shortDebug(t.debugId)}` : ""}
        </span>
      )}
    </>
  );
  return (
    <div className="pp-trace">
      {more.length ? (
        <details className={`pp-call ${failed ? "is-bad" : ""}`}>
          <summary>{summary}</summary>
          <span className="pp-more">{more.join(" · ")}</span>
        </details>
      ) : (
        <span className={`pp-call ${failed ? "is-bad" : ""}`}>{summary}</span>
      )}
    </div>
  );
}

function EventLine({ e, full }: { e: EventRow; full: boolean }) {
  const sim = isSimEvent(e);
  return (
    <li className={e.real ? "ev-real" : sim ? "ev-sim" : "ev-local"} data-kind={e.kind}>
      <time dateTime={new Date(e.ts).toISOString()}>{hms(e.ts)}</time>
      <span className={`tag ${e.real ? "tag-real" : sim ? "tag-sim" : "tag-local"}`}>{e.real ? "PayPal" : sim ? "simulated" : "Paylet"}</span>
      <div className="ev-body">
        <span className="ev-msg">{cleanEventMessage(e.message)}</span>
        {e.trace && <TraceChip t={e.trace} full={full} />}
      </div>
    </li>
  );
}

/**
 * The drop's ledger, polled every 1.5 s. It follows new lines only while you're at the bottom (within 40 px),
 * so reading older lines never jumps.
 */
export function Ticker({
  slug,
  title = "Live ledger",
  traceDefault = false,
  fixed = false,
  onEvents,
}: {
  slug: string;
  title?: string;
  /** "PayPal API trace": on in the seller console, off on the fan page */
  traceDefault?: boolean;
  /** fixed height (console), so the layout around it never moves */
  fixed?: boolean;
  /** events that arrive after the first load (e.g. swarm_done → toast) */
  onEvents?: (events: EventRow[]) => void;
}) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [full, setFull] = useState(traceDefault);
  const ref = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const cb = useRef(onEvents);
  cb.current = onEvents;
  useEffect(() => {
    let alive = true;
    let last = 0;
    let first = true;
    const load = async () => {
      try {
        const r = await api<{ events: EventRow[] }>(`/api/drops/${slug}/events?after=${last}`);
        if (!alive) return;
        const wasFirst = first;
        first = false;
        if (!r.events.length) return;
        last = r.events[r.events.length - 1].id;
        const el = ref.current;
        stick.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        setEvents((prev) => [...prev, ...r.events].slice(-240));
        if (!wasFirst) cb.current?.(r.events);
      } catch {
        /* the next poll retries */
      }
    };
    void load();
    const t = setInterval(load, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [slug]);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events]);
  const items = groupEvents(events);
  const id = `ticker-${slug}`;
  return (
    <section className={`card ticker ${fixed ? "ticker-fixed" : ""}`} aria-labelledby={id} data-testid="ledger">
      <div className="card-head">
        <h3 id={id}>{title}</h3>
        <label className="switch">
          <input type="checkbox" role="switch" checked={full} onChange={(e) => setFull(e.target.checked)} data-testid="trace-toggle" />
          <span className="switch-track" aria-hidden="true" />
          PayPal API trace
        </label>
      </div>
      <p className="legend">
        <span>
          <span className="tag tag-real">PayPal</span> real sandbox call
        </span>
        <span>
          <span className="tag tag-local">Paylet</span> draw &amp; rules
        </span>
        <span>
          <span className="tag tag-sim">simulated</span> labelled, no PayPal call
        </span>
      </p>
      <ol ref={ref} role="log" aria-live="polite" aria-relevant="additions" aria-label={title} tabIndex={0}>
        {events.length === 0 && <li className="ev-empty muted">Nothing yet. PayPal calls show up here as they happen.</li>}
        {items.map((it) =>
          it.type === "one" ? (
            <EventLine key={it.e.id} e={it.e} full={full} />
          ) : (
            <li key={`g${it.events[0].id}`} className="ev-sim ev-group" data-testid="ledger-group">
              <time dateTime={new Date(it.events[0].ts).toISOString()}>{hms(it.events[0].ts)}</time>
              <span className="tag tag-sim">simulated</span>
              <details className="ev-body">
                <summary>
                  <span className="ev-msg">{groupLabel(it.kind, it.events.length)}</span>
                  <span className="ev-show"> · show</span>
                </summary>
                <ul className="ev-sub">
                  {it.events.map((e) => (
                    <li key={e.id}>
                      <time>{hms(e.ts)}</time> {cleanEventMessage(e.message)}
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ),
        )}
      </ol>
    </section>
  );
}
