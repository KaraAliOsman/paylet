import { useCallback, useEffect, useState } from "react";
import { ApiError, api, clock, friendlyError, realOrders, timeLeft, usd, type Participant, type PublicDrop } from "../api";
import { Art, Hash, PayPalEntryButton, Stat, StatusPill, Ticker } from "../components";
import { HoldTimeline, timelineInput } from "../hold-timeline";
import { BotIcon, ClockIcon, ShieldIcon } from "../icons";
import { approvalExpiresAt } from "../timeline";
import { Link, navigate } from "../router";

function useDrop(slug: string) {
  const [drop, setDrop] = useState<PublicDrop | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<PublicDrop>(`/api/drops/${slug}`)
        .then((d) => alive && setDrop(d))
        .catch((e) => alive && setErr(e instanceof ApiError && e.status === 404 ? "not_found" : String(e.message ?? e)));
    void load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [slug]);
  return { drop, err };
}

function useNow(ms = 1000) {
  const [n, setN] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setN(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}

// ---------------------------------------------------------------- Drop page (fan)

export function DropPage({ slug }: { slug: string }) {
  const { drop, err } = useDrop(slug);
  const now = useNow();
  const [entry, setEntry] = useState<{ p: Participant; outcome: string } | null>(null);
  const onEntry = useCallback((p: Participant, outcome: string) => setEntry({ p, outcome }), []);

  const entryId = entry?.p.entryId;
  const entryDone = entry ? TERMINAL.has(entry.p.status) : true;
  useEffect(() => {
    if (!entryId || entryDone) return;
    const t = setInterval(async () => {
      const p = await api<Participant>(`/api/entries/${entryId}`).catch(() => null);
      if (p) setEntry((prev) => (prev && prev.p.entryId === p.entryId ? { ...prev, p } : prev));
    }, 2000);
    return () => clearInterval(t);
  }, [entryId, entryDone]);

  if (err === "not_found") return <NotFound what="drop" />;
  if (err && !drop) return <p className="err">{err}</p>;
  if (!drop) return <div className="skeleton tall">Loading drop…</div>;
  const open = drop.status === "open" && drop.closesAt > now;
  const hold = drop.priceCents + drop.shipHoldCents;
  const charge = drop.priceCents + drop.shipActualCents;
  return (
    <div className="drop">
      <section className="card drop-main">
        <Art art={drop.art} size={260} />
        <div className="drop-info">
          <p className="eyebrow">{drop.kind === "judge" ? "Judge drop · 30 minutes" : drop.kind === "proof" ? "Proof drop · real PayPal sandbox run" : "Limited drop"}</p>
          <h1>{drop.title}</h1>
          <p className="maker">by {drop.maker}</p>
          <p>{drop.blurb}</p>
          <div className="stats">
            <Stat label="units" value={drop.units} />
            <Stat label="price" value={usd(drop.priceCents)} />
            <Stat label="hold (incl. max shipping)" value={usd(hold)} />
            <Stat label={open ? "closes in" : "status"} value={open ? timeLeft(drop.closesAt - now) : DROP_STATUS[drop.status] ?? drop.status} />
          </div>
          {open ? (
            entry ? (
              <div className="entry-box" aria-live="polite">
                <div className="row gap wrap">
                  <StatusPill status={entry.p.status} />
                  <span className="muted small">
                    Entry <code>{entry.p.publicId}</code>
                  </span>
                </div>
                <HoldTimeline input={timelineInput(entry.p, hold)} />
                {entry.outcome === "duplicate" && (
                  <p className="small">Paylet checked PayPal's own record of who approved: that PayPal account already has an entry in this drop, so no second hold was placed.</p>
                )}
                <div className="row gap wrap">
                  <Link href={`/me/${entry.p.entryId}`}>Track this entry →</Link>
                  {drop.kind === "judge" && (
                    <button className="linklike" onClick={() => setEntry(null)}>
                      Try again with the same PayPal account
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="ballot">
                <h2 className="ballot-title">Enter the ballot</h2>
                <ol className="ballot-steps">
                  <li>
                    <span className="ballot-n">1</span>
                    <span>
                      Approve a <b>{usd(hold)}</b> hold in PayPal
                    </span>
                  </li>
                  <li>
                    <span className="ballot-n">2</span>
                    <span>
                      Draw at <b>{clock(drop.closesAt)}</b>
                    </span>
                  </li>
                  <li>
                    <span className="ballot-n">3</span>
                    <span>
                      Charged only if you win (<b>{usd(charge)}</b>). Not selected? Hold voided, <b>$0</b>.
                    </span>
                  </li>
                </ol>
                <PayPalEntryButton slug={drop.slug} onEntry={onEntry} />
                <p className="hint small">
                  One entry per PayPal account. The hold covers the price plus max shipping; a winner pays the real shipping ({usd(drop.shipActualCents)}) and the rest is
                  released.
                </p>
                <Link href={`/agent?drop=${drop.slug}`} className="small agent-link">
                  <BotIcon size={16} /> …or let your AI agent request it (it can't pay: you approve)
                </Link>
              </div>
            )
          ) : (
            <div className="entry-box">
              <p>{closedCopy(drop.status, drop.closesAt, now)}</p>
              <Link className="btn" href={`/verify/${drop.slug}`}>
                Verify the draw
              </Link>
            </div>
          )}
        </div>
      </section>
      <section className="stats wide">
        <Stat label="entry requests (real)" value={realOrders(drop.stats)} />
        <Stat label="via AI agents" value={drop.stats.agents} />
        <Stat label="PayPal holds (real)" value={drop.stats.holds} tone="good" />
        <Stat label="same-account duplicates (no hold)" value={drop.stats.duplicatesBlocked} tone="warn" />
        <Stat label="merged by household/network" value={drop.stats.merged} tone="warn" />
        {drop.stats.simulated > 0 && <Stat label="simulated entrants (no PayPal call)" value={drop.stats.simulated} />}
      </section>
      <div className="commit card">
        <Hash label="Seed commitment (SHA-256)" value={drop.seedHash} />
        <span className="muted small">Published before any entry. The seed is revealed at the draw so anyone can re-run it.</span>
      </div>
      <Ticker slug={drop.slug} title="Public ledger" />
    </div>
  );
}

const TERMINAL = new Set(["captured", "voided", "duplicate", "expired", "error", "refunded", "capture_failed", "merged"]);

const DROP_STATUS: Record<string, string> = { open: "open", frozen: "drawing", drawn: "settling", settled: "settled" };

function closedCopy(status: string, closesAt: number, now: number): string {
  if (status === "open" && closesAt <= now) return "Entries are closed. The draw starts in a moment.";
  if (status === "frozen") return "Entries are closed. The list is frozen and the draw is waiting for public randomness (drand).";
  if (status === "drawn") return "Drawn. PayPal is settling: winners are captured, everyone else is voided.";
  return "This drop is settled. Winners were captured, everyone else's hold was voided.";
}

// ---------------------------------------------------------------- return from PayPal (agent approval links)

export function ReturnPage({ entryId, cancelled }: { entryId: string; cancelled: boolean }) {
  const [msg, setMsg] = useState("Checking PayPal…");
  useEffect(() => {
    if (cancelled) {
      setMsg("You cancelled in PayPal — no hold was placed.");
      return;
    }
    api<{ outcome: string; entry: Participant }>("/api/entries/finalize", { method: "POST", json: { entryId } })
      .then(() => navigate(`/me/${entryId}`))
      .catch((e) => setMsg(`Could not finalize: ${e.message}`));
  }, [entryId, cancelled]);
  return (
    <section className="card narrow">
      <h2>Paylet</h2>
      <p>{msg}</p>
      {cancelled && <Link href={`/me/${entryId}`}>See entry</Link>}
    </section>
  );
}

// ---------------------------------------------------------------- participant view

export function NotFound({ what }: { what: "drop" | "entry" | "page" }) {
  return (
    <section className="card narrow not-found" aria-labelledby="nf-title">
      <p className="eyebrow">{what === "page" ? "404" : "Gone"}</p>
      {what === "page" ? (
        <>
          <h2 id="nf-title">There's no page here</h2>
          <p>The link may be mistyped. Everything in the demo starts from one of these:</p>
        </>
      ) : (
        <>
          <h2 id="nf-title">That {what} isn't here anymore</h2>
          <p>The public demo runs on free hosting and its data resets when it restarts. Nothing was charged.</p>
        </>
      )}
      <div className="row gap wrap">
        <Link className="btn btn-primary" href="/judge?fresh=1">
          Start a fresh judge drop
        </Link>
        <Link className="btn" href="/">
          Home
        </Link>
        {what === "page" && (
          <Link className="btn" href="/how">
            How it works
          </Link>
        )}
      </div>
    </section>
  );
}

export function MePage({ entryId }: { entryId: string }) {
  const [p, setP] = useState<Participant | null>(null);
  const [missing, setMissing] = useState(false);
  const [appeal, setAppeal] = useState("");
  const [sent, setSent] = useState(false);
  const [appealErr, setAppealErr] = useState("");
  const now = useNow();
  useEffect(() => {
    const load = () =>
      api<Participant>(`/api/entries/${entryId}`)
        .then(setP)
        .catch((e) => {
          if (e instanceof ApiError && e.status === 404) setMissing(true);
        });
    void load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [entryId]);
  if (missing && !p) return <NotFound what="entry" />;
  if (!p) return <div className="skeleton tall">Loading…</div>;
  const expiresAt = approvalExpiresAt(p.timeline?.requestedAt, p.drop.closesAt);
  const released = p.holdCents != null && p.capturedCents != null ? p.holdCents - p.capturedCents : null;
  return (
    <section className="card narrow me">
      <div className="row gap center">
        <Art art={p.drop.art} size={88} />
        <div>
          <p className="eyebrow">Your entry {p.publicId}</p>
          <h2>{p.drop.title}</h2>
          <p className="muted">by {p.drop.maker}</p>
        </div>
      </div>
      <div className="row gap wrap">
        <StatusPill status={p.status} />
        {p.payerVerified && (
          <span className="tag tag-real">
            <ShieldIcon size={13} /> PayPal-verified payer
          </span>
        )}
      </div>

      {p.status === "awaiting_person" && (
        <div className="resume">
          <p>
            <b>Your hold isn't placed yet.</b> Approve it in PayPal to enter the ballot. You're charged only if you win.
          </p>
          {p.approveUrl && expiresAt > now ? (
            <>
              <a className="btn btn-paypal" href={p.approveUrl}>
                Approve in PayPal
              </a>
              <span className="muted small">
                <ClockIcon size={14} /> link expires in {timeLeft(expiresAt - now)}
              </span>
            </>
          ) : (
            <span className="muted small">{p.approveUrl ? "This approval link has expired. No hold was placed." : "Use the approval link your agent gave you."}</span>
          )}
        </div>
      )}

      <HoldTimeline input={timelineInput(p)} />

      <dl className="kv">
        <dt>Hold</dt>
        <dd>{usd(p.holdCents)}</dd>
        <dt>Charged</dt>
        <dd>{p.capturedCents ? usd(p.capturedCents) : "nothing"}</dd>
        {released != null && released > 0 && p.status === "captured" && (
          <>
            <dt>Released</dt>
            <dd>{usd(released)} of unused shipping</dd>
          </>
        )}
        {p.refundedCents ? (
          <>
            <dt>Refunded</dt>
            <dd>{usd(p.refundedCents)} · you owe nothing</dd>
          </>
        ) : null}
        {p.shipping && (
          <>
            <dt>Shipped</dt>
            <dd>
              {p.shipping.carrier} <code>{p.shipping.tracking}</code> · also visible in your PayPal account
            </dd>
          </>
        )}
      </dl>
      {p.note && <p className="note">{p.note}</p>}
      {p.explanation && (
        <div className="explain">
          <b>Why:</b> {p.explanation}
        </div>
      )}
      {(p.status === "merged" || p.explanation) && !sent && (
        <div className="appeal">
          <label htmlFor="appeal-text">Not the same household? Tell the seller:</label>
          <textarea id="appeal-text" value={appeal} onChange={(e) => setAppeal(e.target.value)} placeholder="e.g. We're roommates with separate orders." />
          <button
            className="btn"
            onClick={async () => {
              try {
                await api(`/api/entries/${p.entryId}/appeal`, { method: "POST", json: { message: appeal } });
                setSent(true);
              } catch (e) {
                setAppealErr(friendlyError(e));
              }
            }}
          >
            Appeal
          </button>
          {appealErr && <p className="err small">{appealErr}</p>}
        </div>
      )}
      {sent && <p className="hint">Appeal sent. The seller reviews it before the draw.</p>}
      <div className="row gap wrap">
        <Link href={`/d/${p.drop.slug}`}>Back to the drop</Link>
        {["drawn", "settled"].includes(p.drop.status) && <Link href={`/verify/${p.drop.slug}`}>Verify the draw →</Link>}
      </div>
    </section>
  );
}
