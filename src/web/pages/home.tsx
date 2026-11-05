import { useEffect, useState } from "react";
import { api, apiOptional, clock, nf, usd, type DropReport, type GlobalStats, type ProofInfo, type PublicDrop } from "../api";
import { HoldDemo } from "../hold-demo";
import { ArrowIcon, BotIcon, PlayIcon } from "../icons";
import { LiveBoard } from "../live-board";
import { RaceVsBallot } from "../race";
import { Link } from "../router";

/** YouTube link of the demo video; the link shows up on the home page once this is set. */
export const VIDEO_URL = "";

function usePolled<T>(path: string, ms: number): T | null | undefined {
  // undefined = loading, null = this server doesn't have it (yet)
  const [v, setV] = useState<T | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const load = () =>
      apiOptional<T>(path)
        .then((x) => alive && setV(x))
        .catch(() => alive && setV((prev) => (prev === undefined ? null : prev)));
    void load();
    const t = ms > 0 ? setInterval(load, ms) : undefined;
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, [path, ms]);
  return v;
}

export function Home() {
  const [data, setData] = useState<{ open: PublicDrop[]; past: PublicDrop[] } | null>(null);
  const [mcp, setMcp] = useState("");
  const stats = usePolled<GlobalStats>("/api/stats", 15_000);
  const proof = usePolled<ProofInfo>("/api/proof", 0);
  useEffect(() => {
    void api<{ open: PublicDrop[]; past: PublicDrop[] }>("/api/drops")
      .then(setData)
      .catch(() => setData({ open: [], past: [] }));
    void api<{ mcpUrl: string }>("/api/config")
      .then((c) => setMcp(c.mcpUrl))
      .catch(() => undefined);
  }, []);
  const drop = data?.open[0];
  const proofSlug = proof?.slug ?? null;
  const verifyHref = proofSlug ? `/verify/${proofSlug}` : null;
  return (
    <>
      <section className="hx">
        <p className="kicker">For makers with more fans than stock · on PayPal</p>
        <h1 className="hx-title">
          One unit per{" "}
          <span className="hx-held">
            <span className="held-tag" aria-hidden="true">
              Hold · $48.00 · authorized
            </span>
            PayPal account.
          </span>{" "}
          <span className="hx-second">Agents welcome.</span>
        </h1>
        <div className="hx-grid">
          <div className="hx-copy">
            <p className="hx-lede">Every entry is a PayPal hold. One per PayPal account. Losers are never charged.</p>
            <div className="cta">
              <Link className="btn btn-primary btn-lg" href="/judge">
                Judges: 2-minute guided demo <ArrowIcon size={16} />
              </Link>
              {drop && (
                <Link className="btn btn-lg" href={`/d/${drop.slug}`}>
                  Enter the {drop.title} drop
                </Link>
              )}
            </div>
            <Link className="cta-link" href="/agent">
              <BotIcon size={16} /> Let my AI agent enter <ArrowIcon size={14} />
            </Link>
            {VIDEO_URL && (
              <a className="video-link" href={VIDEO_URL} target="_blank" rel="noopener">
                <PlayIcon size={15} /> Watch the demo video
              </a>
            )}
            <LiveCounters stats={stats} />
          </div>
          <LiveBoard slug={proofSlug} />
        </div>
      </section>

      <section className="rules" aria-labelledby="rules-title">
        <h2 id="rules-title" className="sr-only">
          The three rules
        </h2>
        {RULES.map((r, i) => (
          <article key={r.title} className="rule">
            <span className="rule-n">{String(i + 1).padStart(2, "0")}</span>
            <h3>{r.title}</h3>
            <p>{r.text}</p>
            <code>{r.api}</code>
          </article>
        ))}
      </section>

      <section className="outcomes" aria-labelledby="outcomes-title">
        <div className="outcomes-copy">
          <p className="kicker">What happens to your $48</p>
          <h2 id="outcomes-title">A hold, not a charge.</h2>
          <p>
            The fan approves the price plus the most shipping could cost. Nothing moves until the draw. Then PayPal does exactly one of these, and
            anyone can check which.
          </p>
          {verifyHref && (
            <Link className="text-link" href={verifyHref}>
              Check the proof drop with PayPal <ArrowIcon size={14} />
            </Link>
          )}
        </div>
        <HoldDemo verifyHref={verifyHref} />
      </section>

      <RaceVsBallot />

      <section className="sec" aria-labelledby="flow-title">
        <div className="sec-head">
          <h2 id="flow-title">How a drop works</h2>
          <Link href="/how#sequence">
            Every PayPal call, in order <ArrowIcon size={13} />
          </Link>
        </div>
        <ol className="timeline">
          {FLOW.map((f, i) => (
            <li key={f.title} className={f.real ? "real" : ""}>
              <span className="tl-n">{i + 1}</span>
              <b>{f.title}</b>
              <p>{f.text}</p>
              <code>{f.api}</code>
            </li>
          ))}
        </ol>
      </section>

      {proof?.slug && <ProofCard proof={proof} />}

      <section className="sec two">
        <div className="card">
          <p className="kicker">For AI agents</p>
          <h3>Paylet speaks MCP</h3>
          <p>
            Any assistant can enter drops for its person through Paylet's MCP server. It can <b>request</b> an entry. It can never approve or pay.
          </p>
          <code className="block">{mcp || "…/mcp"}</code>
          <p className="muted small">Tools: list_drops · enter_drop · entry_status (Streamable HTTP)</p>
        </div>
        <div className="card">
          <p className="kicker">For judges</p>
          <h3>Try to scalp us</h3>
          <p>
            Spin up your own 30-minute drop with its own seller console, then try to get two units with one PayPal account. A checklist walks you through it.
          </p>
          <Link className="btn btn-primary" href="/judge">
            Start a judge drop <ArrowIcon size={15} />
          </Link>
        </div>
      </section>

      {data && data.past.length > 0 && (
        <section className="sec card">
          <h3>Past drops (verifiable)</h3>
          <ul className="plain">
            {data.past.map((d) => (
              <li key={d.id}>
                <Link href={`/verify/${d.slug}`}>
                  {d.title}: {d.stats.captured + (d.stats.capturedSimulated ?? 0)}/{d.units} paid · {d.stats.duplicatesBlocked} duplicates blocked ·{" "}
                  {d.stats.merged} merged · re-run the draw
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** Live, real-only counters (fixed height, so nothing jumps while it loads; hidden if the server has no /api/stats). */
function LiveCounters({ stats }: { stats: GlobalStats | null | undefined }) {
  if (stats === null) return null;
  const items: [string, string][] = stats
    ? [
        [nf(stats.agentRequests), "agent requests"],
        [nf(stats.duplicatesBlocked), "same-account duplicates blocked"],
        // "$0 to losers" only means something once somebody has lost
        stats.voidedHolds ? [usd(stats.chargedToLosersCents).replace(".00", ""), `charged across ${nf(stats.voidedHolds)} voided holds`] : [nf(stats.holds), "real holds placed"],
      ]
    : [];
  return (
    <div className="live" aria-live="polite" aria-busy={!stats}>
      <span className="live-tag">
        <span className="live-dot" aria-hidden="true" /> Live · real PayPal sandbox calls only
      </span>
      <div className="live-row">
        {stats
          ? items.map(([n, l]) => (
              <div key={l} className="live-item">
                <b>{n}</b>
                <span>{l}</span>
              </div>
            ))
          : [0, 1, 2].map((i) => <div key={i} className="live-item skeleton" />)}
      </div>
    </div>
  );
}

function ProofCard({ proof }: { proof: ProofInfo }) {
  const report = usePolled<DropReport>(`/api/drops/${proof.slug}/report`, 0);
  const released = report ? usd(report.shippingReleasedCents) : "…";
  return (
    <section className="sec proof-sec" aria-labelledby="proof-title">
      <div className="proof-grid">
        <div className="proof-copy">
          <p className="kicker">Not a mockup</p>
          <h2>Every number here came back from PayPal.</h2>
        </div>
        <dl className="proof-nums">
          <div>
            <dt>Captured from the winner</dt>
            <dd>{report ? usd(report.capturedCents) : "…"}</dd>
          </div>
          <div>
            <dt>Of the hold released</dt>
            <dd>{released}</dd>
          </div>
          <div>
            <dt>Agent requests → holds</dt>
            <dd>{report ? `${report.agentRequests} → ${report.agentHoldsWithoutPerson}` : "…"}</dd>
          </div>
          <div>
            <dt>{report?.holdsVoided ? "Charged to anyone who lost" : "Same-account duplicates blocked"}</dt>
            <dd>{report ? (report.holdsVoided ? usd(report.chargedToLosersCents) : report.sameAccountDuplicates) : "…"}</dd>
          </div>
        </dl>
      </div>
      <div className="card proof">
        <div className="proof-body">
          <h3 id="proof-title">A finished run with real PayPal sandbox money</h3>
          {proof.summary && <p>{proof.summary}</p>}
          {proof.checkedAt && <p className="muted small">Every ID re-checked with PayPal at {clock(proof.checkedAt)}.</p>}
        </div>
        <div className="proof-actions">
          <Link className="btn btn-primary" href={`/verify/${proof.slug}`}>
            Verify + ask PayPal
          </Link>
          <Link className="btn" href={`/d/${proof.slug}`}>
            Open the drop
          </Link>
        </div>
      </div>
    </section>
  );
}

const RULES = [
  {
    title: "One PayPal account, one unit.",
    text: "PayPal's own order record says who approved. A second approval from the same account never becomes a hold.",
    api: "payer_id · HMAC · unique per drop",
  },
  {
    title: "Agents can ask. People approve.",
    text: "Any AI agent can request an entry over MCP. It gets a PayPal approval link, and that's where it stops.",
    api: "MCP enter_drop → PAYER_ACTION_REQUIRED",
  },
  {
    title: "Losing costs nothing.",
    text: "Every entry is an authorization. Winners pay the price plus real shipping; every other hold is voided.",
    api: "AUTHORIZE → capture | void",
  },
];

const FLOW: { title: string; text: string; api: string; real?: boolean }[] = [
  { title: "Request", text: "A fan, or their AI agent over MCP, asks for an entry.", api: "MCP enter_drop" },
  { title: "Approve a hold", text: "The person approves a hold in PayPal. Agents can't.", api: "Orders v2 · AUTHORIZE", real: true },
  { title: "One per account", text: "PayPal's order record says who approved. A second entry from that account gets no hold.", api: "payer_id", real: true },
  { title: "Public draw", text: "The list is frozen, then public randomness picks the winners. Re-run it yourself.", api: "SHA-256 + drand" },
  { title: "Settle", text: "Winners pay price + real shipping. Everyone else: hold voided, $0.", api: "capture · void", real: true },
];
