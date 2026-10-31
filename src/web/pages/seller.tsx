import { useCallback, useEffect, useState } from "react";
import { api, timeLeft, usd, type PublicDrop } from "../api";
import { Art, Hash, ShortStatus, Stat, Ticker } from "../components";
import { Link } from "../router";

interface SellerEntry {
  id: string;
  publicId: string;
  source: string;
  agentLabel: string | null;
  status: string;
  displayName: string | null;
  name: string | null;
  address: { line1: string; line2?: string; city?: string; state?: string; zip?: string } | null;
  holdCents: number | null;
  capturedCents: number | null;
  authorizationId: string | null;
  clusterId: string | null;
  note: string | null;
}

interface Cluster {
  id: string;
  kind: "household" | "operator";
  status: "suggested" | "confirmed" | "dismissed";
  method: "rules" | "ai";
  confidence: number;
  evidence: { field: string; detail: string }[];
  explanation: string;
  memberIds: string[];
}

interface SellerData {
  drop: PublicDrop & { negativeTest: boolean };
  entries: SellerEntry[];
  clusters: Cluster[];
  ai: { calls: number; today: number; dailyCap: number; model: string; ms: number };
}

export function SellerPage({ slug, sellerKey }: { slug: string; sellerKey: string }) {
  const [data, setData] = useState<SellerData | null>(null);
  const [busy, setBusy] = useState<string>("");
  const [flash, setFlash] = useState<string>("");
  const [err, setErr] = useState<string>("");
  const [filter, setFilter] = useState<"all" | "real" | "simulated">("all");

  const load = useCallback(async () => {
    try {
      setData(await api<SellerData>(`/api/seller/${slug}`, { sellerKey }));
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [slug, sellerKey]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [load]);

  const act = async (label: string, path: string, json?: unknown) => {
    setBusy(label);
    setFlash("");
    try {
      const r = await api<Record<string, unknown>>(`/api/seller/${slug}/${path}`, { method: "POST", sellerKey, json: json ?? {} });
      setFlash(`${label}: ${JSON.stringify(r).replace(/[{}"]/g, "").replace(/,/g, " · ").slice(0, 160)}`);
      await load();
    } catch (e) {
      setFlash(`${label} failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy("");
    }
  };

  if (err && !data) return <section className="card narrow"><h2>Seller console</h2><p className="err">{err}</p></section>;
  if (!data) return <div className="skeleton tall">Loading console…</div>;
  const { drop, entries, clusters } = data;
  const open = drop.status === "open" && drop.closesAt > Date.now();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const visible = entries.filter((e) => (filter === "all" ? true : filter === "real" ? e.source !== "simulated" : e.source === "simulated"));

  return (
    <div className="seller">
      <section className="card seller-head">
        <Art art={drop.art} size={96} />
        <div className="grow">
          <p className="eyebrow">Seller console · {drop.maker}</p>
          <h1>{drop.title}</h1>
          <p className="muted">
            {drop.units} units · {usd(drop.priceCents)} + shipping (hold {usd(drop.priceCents + drop.shipHoldCents)}, actual {usd(drop.shipActualCents)}) ·{" "}
            {open ? `closes in ${timeLeft(drop.closesAt - Date.now())}` : drop.status}
          </p>
          <div className="row gap wrap">
            <Link href={`/d/${drop.slug}`} className="btn btn-sm">
              Fan page ↗
            </Link>
            <Link href={`/verify/${drop.slug}`} className="btn btn-sm">
              Verify page ↗
            </Link>
          </div>
        </div>
        <Hash label="seed commitment" value={drop.seedHash} />
      </section>

      <section className="stats wide">
        <Stat label="entry requests" value={drop.stats.requests} />
        <Stat label="awaiting a person" value={drop.stats.awaitingPerson} />
        <Stat label="PayPal holds" value={drop.stats.holds} tone="good" />
        <Stat label="same-account duplicates (no hold)" value={drop.stats.duplicatesBlocked} tone="warn" />
        <Stat label="merged" value={drop.stats.merged} tone="warn" />
        <Stat label="captured" value={drop.stats.captured} tone="good" />
      </section>

      <section className="card actions">
        <h3>Run the drop</h3>
        <div className="row gap wrap">
          <button className="btn" disabled={!open || !!busy} onClick={() => act("Scalper swarm", "swarm", { n: 12 })}>
            🤖 Unleash 12 scalper agents (MCP)
          </button>
          <button className="btn" disabled={!open || !!busy} onClick={() => act("Simulated crowd", "simulate")}>
            👥 Add simulated crowd (labelled)
          </button>
          <button className="btn btn-accent" disabled={!open || !!busy} onClick={() => act("AI review", "analyze")}>
            {busy === "AI review" ? "AI reviewing…" : "✨ Find households & networks (AI)"}
          </button>
          <label className="toggle">
            <input type="checkbox" checked={drop.negativeTest} disabled={!open} onChange={(e) => act("Negative test", "negative-test", { on: e.target.checked })} />
            Sandbox negative test: make one winner's payment fail
          </label>
          <button className="btn btn-primary" disabled={!open || !!busy} onClick={() => act("Draw", "draw")}>
            🎲 Close & draw
          </button>
        </div>
        {flash && <p className="hint">{flash}</p>}
        <p className="muted small">
          AI: {data.ai.model} · {data.ai.today}/{data.ai.dailyCap} calls today. Nothing is auto-merged: AI suggestions only take effect when you confirm them.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Households & reseller networks</h3>
          <span className="muted small">{clusters.filter((c) => c.status === "suggested").length} awaiting your decision</span>
        </div>
        {clusters.length === 0 && <p className="muted">Run the AI review to look for accounts that belong to one household or operation.</p>}
        <div className="clusters">
          {clusters.map((c) => (
            <article key={c.id} className={`cluster cluster-${c.status}`}>
              <header>
                <span className={`badge badge-${c.kind}`}>{c.kind === "operator" ? "Reseller network" : "Household"}</span>
                <span className={`badge ${c.method === "ai" ? "badge-ai" : "badge-rules"}`}>{c.method === "ai" ? "AI-adjudicated" : "Rules"}</span>
                <span className="muted small">confidence {(c.confidence * 100).toFixed(0)}%</span>
                <span className="grow" />
                {c.status === "suggested" ? (
                  <>
                    <button className="btn btn-sm btn-primary" disabled={!open} onClick={() => act("Confirm", `clusters/${c.id}`, { decision: "confirmed" })}>
                      Confirm — one unit max
                    </button>
                    <button className="btn btn-sm" disabled={!open} onClick={() => act("Dismiss", `clusters/${c.id}`, { decision: "dismissed" })}>
                      Not the same
                    </button>
                  </>
                ) : (
                  <span className={`pill pill-${c.status === "confirmed" ? "warn" : "muted"} pill-sm`}>{c.status}</span>
                )}
              </header>
              <p className="explain">{c.explanation}</p>
              <ul className="members">
                {c.memberIds.map((m) => {
                  const e = byId.get(m);
                  if (!e) return null;
                  return (
                    <li key={m}>
                      <code>{e.publicId}</code> {e.name} — {e.address?.line1} {e.address?.line2} {e.address?.zip}
                      {e.source === "simulated" && <span className="tag tag-sim">sim</span>}
                    </li>
                  );
                })}
              </ul>
              <ul className="evidence">
                {c.evidence.map((ev, i) => (
                  <li key={i}>
                    <b>{ev.field}</b> {ev.detail}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <div className="split">
        <section className="card">
          <div className="card-head">
            <h3>Entries</h3>
            <div className="seg">
              {(["all", "real", "simulated"] as const).map((f) => (
                <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                  {f}
                </button>
              ))}
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Entry</th>
                  <th>Via</th>
                  <th>Name</th>
                  <th>Ships to</th>
                  <th>Hold</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visible
                  .slice()
                  .reverse()
                  .map((e) => (
                    <tr key={e.id} title={e.note ?? ""}>
                      <td>
                        <code>{e.publicId}</code>
                      </td>
                      <td>
                        {e.source === "simulated" ? <span className="tag tag-sim">simulated</span> : e.source === "agent" ? <span className="tag tag-agent">{e.agentLabel ?? "agent"}</span> : <span className="tag tag-real">person</span>}
                      </td>
                      <td>{e.displayName ?? "—"}</td>
                      <td className="small">{e.address ? `${e.address.city ?? ""} ${e.address.state ?? ""} ${e.address.zip ?? ""}` : "—"}</td>
                      <td>{usd(e.holdCents)}</td>
                      <td>
                        <ShortStatus status={e.status} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
        <Ticker slug={drop.slug} title="Settlement ledger" sellerView />
      </div>
    </div>
  );
}
