import { useCallback, useEffect, useState } from "react";
import { ApiError, api, timeLeft, usd, type Participant, type PublicDrop } from "../api";
import { Art, Hash, PayPalEntryButton, Stat, StatusPill, Ticker } from "../components";
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

// ---------------------------------------------------------------- Home

export function Home() {
  const [data, setData] = useState<{ open: PublicDrop[]; past: PublicDrop[] } | null>(null);
  const [mcp, setMcp] = useState("");
  useEffect(() => {
    void api<{ open: PublicDrop[]; past: PublicDrop[] }>("/api/drops").then(setData);
    void api<{ mcpUrl: string }>("/api/config").then((c) => setMcp(c.mcpUrl));
  }, []);
  const drop = data?.open[0];
  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">Fair drops for the agent era</p>
          <h1>
            One unit per PayPal account.
            <br />
            <em>Agents welcome.</em>
          </h1>
          <p className="lede">
            Small makers sell limited runs by hand — a form, a PayPal invoice, and a prayer that scalpers don't take everything. Paylet turns every entry into a{" "}
            <b>PayPal hold</b>, allows <b>one per PayPal account</b>, uses <b>AI</b> to collapse households and reseller networks (the seller decides), and runs a{" "}
            <b>verifiable draw</b>. Winners are captured, everyone else is released — never charged.
          </p>
          <div className="row gap">
            {drop && (
              <Link className="btn btn-primary" href={`/d/${drop.slug}`}>
                Enter the {drop.title} drop
              </Link>
            )}
            <Link className="btn" href="/agent">
              Let my AI agent enter
            </Link>
          </div>
        </div>
        {drop && (
          <Link href={`/d/${drop.slug}`} className="hero-card">
            <Art art={drop.art} size={240} />
            <div>
              <b>{drop.title}</b>
              <span>{drop.maker}</span>
              <span>
                {drop.units} units · {usd(drop.priceCents)}
              </span>
            </div>
          </Link>
        )}
      </section>

      <section className="steps">
        {[
          ["1", "Enter = PayPal hold", "Fans (or their AI agents) request an entry. The person approves a hold in PayPal — nothing is charged."],
          ["2", "One per PayPal account", "Paylet reads the payer from PayPal's own order record. A second entry from the same account places no hold."],
          ["3", "AI collapses networks", "Rules handle the obvious; the AI adjudicates fuzzy cases (forwarder suites, c/o, nicknames) and explains why. The seller confirms."],
          ["4", "Verifiable draw", "Seed committed up front, list frozen, seed revealed. Winners captured, losers voided, failed payments pass to the waitlist."],
        ].map(([n, t, d]) => (
          <div className="step card" key={n}>
            <span className="step-n">{n}</span>
            <h3>{t}</h3>
            <p>{d}</p>
          </div>
        ))}
      </section>

      <section className="two">
        <div className="card">
          <h3>For AI agents (MCP)</h3>
          <p>
            Any assistant can enter drops for its person through Paylet's MCP server. It can <b>request</b> an entry — it can never approve or pay.
          </p>
          <code className="block">{mcp || "…/mcp"}</code>
          <p className="muted small">Tools: list_drops · enter_drop · entry_status (Streamable HTTP)</p>
        </div>
        <div className="card">
          <h3>Judges: try to scalp us</h3>
          <p>Spin up your own 30-minute drop with its own seller console, then try to get two units with one PayPal account.</p>
          <Link className="btn btn-primary" href="/judge">
            Start a judge drop
          </Link>
        </div>
      </section>

      {data && data.past.length > 0 && (
        <section className="card">
          <h3>Past drops (verifiable)</h3>
          <ul className="plain">
            {data.past.map((d) => (
              <li key={d.id}>
                <Link href={`/verify/${d.slug}`}>
                  {d.title} — {d.stats.captured + (d.stats.capturedSimulated ?? 0)}/{d.units} paid · {d.stats.duplicatesBlocked} duplicates blocked · {d.stats.merged} merged — re-run the draw
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Drop page (fan)

export function DropPage({ slug }: { slug: string }) {
  const { drop, err } = useDrop(slug);
  const now = useNow();
  const [entry, setEntry] = useState<{ p: Participant; outcome: string } | null>(null);
  const onEntry = useCallback((p: Participant, outcome: string) => setEntry({ p, outcome }), []);

  useEffect(() => {
    if (!entry || ["captured", "voided", "duplicate", "expired", "error"].includes(entry.p.status)) return;
    const t = setInterval(async () => {
      const p = await api<Participant>(`/api/entries/${entry.p.entryId}`);
      setEntry((prev) => (prev ? { ...prev, p } : prev));
    }, 2000);
    return () => clearInterval(t);
  }, [entry]);

  if (err === "not_found") return <NotFound what="drop" />;
  if (err && !drop) return <p className="err">{err}</p>;
  if (!drop) return <div className="skeleton tall">Loading drop…</div>;
  const open = drop.status === "open" && drop.closesAt > now;
  const hold = drop.priceCents + drop.shipHoldCents;
  return (
    <div className="drop">
      <section className="card drop-main">
        <Art art={drop.art} size={260} />
        <div className="drop-info">
          <p className="eyebrow">{drop.kind === "judge" ? "Judge drop · 30 minutes" : "Limited drop"}</p>
          <h1>{drop.title}</h1>
          <p className="maker">by {drop.maker}</p>
          <p>{drop.blurb}</p>
          <div className="stats">
            <Stat label="units" value={drop.units} />
            <Stat label="price" value={usd(drop.priceCents)} />
            <Stat label="hold (incl. max shipping)" value={usd(hold)} />
            <Stat label={open ? "closes in" : "status"} value={open ? timeLeft(drop.closesAt - now) : drop.status} />
          </div>
          {open ? (
            entry ? (
              <div className="entry-box">
                <StatusPill status={entry.p.status} />
                <p>
                  Entry <b>{entry.p.publicId}</b>.{" "}
                  {entry.outcome === "duplicate"
                    ? "Paylet checked PayPal's record of who approved: that account already has an entry in this drop."
                    : "You'll only be charged if you're selected — losers' holds are voided."}
                </p>
                <Link href={`/me/${entry.p.entryId}`}>Track this entry →</Link>
              </div>
            ) : (
              <>
                <PayPalEntryButton slug={drop.slug} onEntry={onEntry} />
                <Link href={`/agent?drop=${drop.slug}`} className="small">
                  …or let your AI agent request it (it can't pay — you approve)
                </Link>
                <p className="hint">
                  Approving places a <b>{usd(hold)}</b> hold (price + max shipping). Winners pay the real shipping; everyone else is released. One entry per PayPal
                  account.
                </p>
              </>
            )
          ) : (
            <div className="entry-box">
              <p>This drop is closed. </p>
              <Link className="btn" href={`/verify/${drop.slug}`}>
                Verify the draw
              </Link>
            </div>
          )}
        </div>
      </section>
      <section className="stats wide">
        <Stat label="entry requests (real)" value={drop.stats.requests} />
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

export function NotFound({ what }: { what: string }) {
  return (
    <section className="card narrow">
      <h2>That {what} isn't here anymore</h2>
      <p>The public demo runs on free hosting and resets its data after it sleeps. Nothing was charged.</p>
      <div className="row gap">
        <Link className="btn btn-primary" href="/judge">
          Start a fresh judge drop
        </Link>
        <Link className="btn" href="/">
          Home
        </Link>
      </div>
    </section>
  );
}

export function MePage({ entryId }: { entryId: string }) {
  const [p, setP] = useState<Participant | null>(null);
  const [missing, setMissing] = useState(false);
  const [appeal, setAppeal] = useState("");
  const [sent, setSent] = useState(false);
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
      <StatusPill status={p.status} />
      {p.source === "agent" && <p className="muted small">Requested by your agent "{p.agentLabel}". Only you could approve it.</p>}
      <dl className="kv">
        <dt>Hold</dt>
        <dd>{usd(p.holdCents)}</dd>
        <dt>Charged</dt>
        <dd>{p.capturedCents ? usd(p.capturedCents) : "nothing"}</dd>
      </dl>
      {p.note && <p className="note">{p.note}</p>}
      {p.explanation && (
        <div className="explain">
          <b>Why:</b> {p.explanation}
        </div>
      )}
      {(p.status === "merged" || p.explanation) && !sent && (
        <div className="appeal">
          <label>Not the same household? Tell the seller:</label>
          <textarea value={appeal} onChange={(e) => setAppeal(e.target.value)} placeholder="e.g. We're roommates with separate orders." />
          <button
            className="btn"
            onClick={async () => {
              await api(`/api/entries/${p.entryId}/appeal`, { method: "POST", json: { message: appeal } });
              setSent(true);
            }}
          >
            Appeal
          </button>
        </div>
      )}
      {sent && <p className="hint">Appeal sent — the seller reviews it before the draw.</p>}
      <Link href={`/d/${p.drop.slug}`}>Back to the drop</Link>
    </section>
  );
}
