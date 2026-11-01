import { useEffect, useState, type ReactNode } from "react";
import { api, apiOptional, clock, nf, usd, type GlobalStats, type ProofInfo, type PublicDrop } from "../api";
import { HoldDemo } from "../hold-demo";
import { ArrowIcon, BotIcon, CheckIcon, DiceIcon, PlayIcon, ShieldIcon, UserIcon } from "../icons";
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
  const verifyHref = proof?.slug ? `/verify/${proof.slug}` : null;
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          {verifyHref ? (
            <Link className="hero-eyebrow" href={verifyHref}>
              <i>Proof</i> A finished run with real PayPal sandbox money <ArrowIcon size={13} />
            </Link>
          ) : (
            <p className="hero-eyebrow">
              <i>Sandbox</i> Fair drops for the agent era
            </p>
          )}
          <h1 className="hero-title">
            One unit per PayPal account. <span>Agents welcome.</span>
          </h1>
          <p className="hero-lede">
            Every entry is a PayPal hold. One per PayPal account. Losers are never charged.
          </p>
          <div className="cta">
            <Link className="btn btn-primary btn-lg" href="/judge">
              Judges: 2-minute guided demo
            </Link>
            {drop && (
              <Link className="btn btn-lg" href={`/d/${drop.slug}`}>
                Enter the {drop.title} drop
              </Link>
            )}
            <Link className="cta-link" href="/agent">
              <BotIcon size={16} /> Let my AI agent enter <ArrowIcon size={14} />
            </Link>
          </div>
          {VIDEO_URL && (
            <a className="video-link" href={VIDEO_URL} target="_blank" rel="noopener">
              <PlayIcon size={15} /> Watch the demo video
            </a>
          )}
          <LiveCounters stats={stats} />
        </div>
        <HoldDemo verifyHref={verifyHref} />
      </section>

      <section className="sec" aria-labelledby="flow-title">
        <div className="sec-head">
          <div>
            <h2 id="flow-title">How a drop works</h2>
            <p>An agent can ask. Only a person can approve. PayPal's own records decide who is who.</p>
          </div>
          <Link href="/how#sequence">
            Every PayPal call, in order <ArrowIcon size={13} />
          </Link>
        </div>
        <ol className="flow-steps">
          {FLOW.map((f, i) => (
            <li key={f.title} className="flow-step">
              <span className={`flow-icon ${f.local ? "" : "flow-icon-real"}`}>{f.icon}</span>
              <b className="flow-title">
                <span className="flow-num">{String(i + 1).padStart(2, "0")}</span> {f.title}
              </b>
              <p>{f.text}</p>
              {f.api && <span className={`tag ${f.local ? "tag-local" : "tag-real"}`}>{f.api}</span>}
            </li>
          ))}
        </ol>
      </section>

      {proof?.slug && (
        <section className="sec">
          <ProofCard proof={proof} />
        </section>
      )}

      <section className="sec two">
        <div className="card">
          <span className="flow-icon">
            <BotIcon />
          </span>
          <h3>For AI agents (MCP)</h3>
          <p>
            Any assistant can enter drops for its person through Paylet's MCP server. It can <b>request</b> an entry. It can never approve or pay.
          </p>
          <code className="block">{mcp || "…/mcp"}</code>
          <p className="muted small">Tools: list_drops · enter_drop · entry_status (Streamable HTTP)</p>
        </div>
        <div className="card">
          <span className="flow-icon">
            <ShieldIcon />
          </span>
          <h3>Judges: try to scalp us</h3>
          <p>
            Spin up your own 30-minute drop with its own seller console, then try to get two units with one PayPal account. A checklist walks you through it.
          </p>
          <Link className="btn btn-primary" href="/judge">
            Start a judge drop
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
        [usd(stats.chargedToLosersCents).replace(".00", ""), "charged to anyone who lost"],
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
  return (
    <section className="card proof" aria-labelledby="proof-title">
      <span className="proof-badge" aria-hidden="true">
        <ShieldIcon size={20} />
      </span>
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
    </section>
  );
}

const FLOW: { icon: ReactNode; title: string; text: string; api?: string; local?: boolean }[] = [
  { icon: <UserIcon />, title: "Request", text: "A fan, or their AI agent over MCP, asks for an entry.", api: "MCP enter_drop", local: true },
  { icon: <ShieldIcon />, title: "Approve a hold", text: "The person approves a hold in PayPal. Agents can't.", api: "Orders v2 · AUTHORIZE" },
  {
    icon: <CheckIcon />,
    title: "One per account",
    text: "PayPal's order record says who approved. A second entry from that account gets no hold.",
    api: "payer_id",
  },
  {
    icon: <DiceIcon />,
    title: "Public draw",
    text: "The list is frozen, then public randomness picks the winners. Re-run it yourself.",
    api: "SHA-256 + drand",
    local: true,
  },
  { icon: <ArrowIcon />, title: "Settle", text: "Winners pay price + real shipping. Everyone else: hold voided, $0.", api: "capture · void" },
];
