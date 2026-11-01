import { useEffect, useState } from "react";
import { ApiError, api, friendlyError, usd } from "../api";
import { Link } from "../router";

// ---------------------------------------------------------------- Evals

interface EvalRow {
  system: string;
  precision: number;
  recall: number;
  f1: number;
  falseMerges: number;
  missedLinks: number;
  llmCalls: number;
  ms: number;
}

export function EvalsPage() {
  const [d, setD] = useState<{
    available: boolean;
    dataset?: { entries: number; groups: number; sha256: string; generator: string };
    results?: EvalRow[];
    byKind?: Record<string, Record<string, number>>;
    ranAt?: string;
    model?: string;
    notes?: string[];
  } | null>(null);
  useEffect(() => {
    void api<typeof d>("/api/evals").then(setD);
  }, []);
  if (!d) return <div className="skeleton tall">Loading…</div>;
  if (!d.available)
    return (
      <section className="card narrow">
        <h2>Evals</h2>
        <p>No eval run published yet.</p>
      </section>
    );
  return (
    <section className="card evals">
      <p className="eyebrow">Measured, not vibes</p>
      <h2>Entity-resolution evals</h2>
      <p>
        Frozen adversarial dataset: <b>{d.dataset!.entries}</b> PayPal-account entries in <b>{d.dataset!.groups}</b> true people/operations (
        {d.dataset!.generator}). SHA-256 <code>{d.dataset!.sha256.slice(0, 16)}…</code>. Pairwise metrics: a "link" means "these two accounts should share one
        allocation".
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>System</th>
              <th>Precision</th>
              <th>Recall</th>
              <th>F1</th>
              <th>False merges</th>
              <th>Missed links</th>
              <th>LLM calls</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {d.results!.map((r) => (
              <tr key={r.system} className={r.system.startsWith("Paylet") ? "hl" : ""}>
                <td>{r.system}</td>
                <td>{(r.precision * 100).toFixed(1)}%</td>
                <td>{(r.recall * 100).toFixed(1)}%</td>
                <td>
                  <b>{(r.f1 * 100).toFixed(1)}%</b>
                </td>
                <td>{r.falseMerges}</td>
                <td>{r.missedLinks}</td>
                <td>{r.llmCalls}</td>
                <td>{(r.ms / 1000).toFixed(1)}s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.notes && (
        <ul className="plain small">
          {d.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <p className="muted small">
        Model: {d.model} · run {d.ranAt}. Reproduce: <code>pnpm evals</code>. A false merge costs a real fan their chance, so Paylet never auto-merges — the
        seller confirms.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- Judge mode

const JUDGE_KEY = "paylet.judge";

export function JudgePage() {
  // keep the judge's links across navigation and reloads (URL first, then localStorage); /judge?fresh=1 starts over
  const [res, setRes] = useState<{ slug: string; sellerKey: string } | null>(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("fresh") === "1") {
      localStorage.removeItem(JUDGE_KEY);
      window.history.replaceState({}, "", "/judge");
      return null;
    }
    if (q.get("d") && q.get("k")) return { slug: q.get("d")!, sellerKey: q.get("k")! };
    try {
      return JSON.parse(localStorage.getItem(JUDGE_KEY) ?? "null");
    } catch {
      return null;
    }
  });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // a restored drop may be gone (the demo restarted) or already finished: say so instead of handing out dead links
  const [restored, setRestored] = useState<"gone" | "finished" | null>(null);
  useEffect(() => {
    if (!res) return;
    let alive = true;
    api<{ status: string }>(`/api/drops/${res.slug}`)
      .then((d) => alive && setRestored(d.status === "drawn" || d.status === "settled" ? "finished" : null))
      .catch((e) => {
        if (!alive || !(e instanceof ApiError && e.status === 404)) return;
        localStorage.removeItem(JUDGE_KEY);
        window.history.replaceState({}, "", "/judge");
        setRes(null);
        setRestored("gone");
      });
    return () => {
      alive = false;
    };
  }, [res]);
  return (
    <section className="card narrow judge">
      <p className="eyebrow">Judge mode</p>
      <h2>Try to scalp us</h2>
      {restored === "gone" && (
        <p className="alert" role="status">
          Your previous drop is gone (the demo restarted). Start a new one below.
        </p>
      )}
      {restored === "finished" && res && (
        <p className="alert alert-ok" role="status">
          Your drop is settled → <Link href={`/verify/${res.slug}`}>Verify the draw</Link> ·{" "}
          <button
            className="linklike"
            onClick={() => {
              localStorage.removeItem(JUDGE_KEY);
              window.history.replaceState({}, "", "/judge");
              setRestored(null);
              setRes(null);
            }}
          >
            Start another
          </button>
        </p>
      )}
      <ol>
        <li>Start your own 30-minute drop (2 units). You get its fan page and its seller console.</li>
        <li>Enter with a PayPal sandbox buyer account (credentials are in the Devpost testing instructions).</li>
        <li>Try again with the same account — in another tab, or through an AI agent via MCP. Watch "no hold placed".</li>
        <li>In the seller console: add the simulated crowd, run the AI review, confirm a cluster, then Close & draw.</li>
        <li>Open the verify page and re-run the draw in your browser.</li>
      </ol>
      {!res ? (
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ slug: string; sellerKey: string }>("/api/judge-drop", { method: "POST" });
              localStorage.setItem(JUDGE_KEY, JSON.stringify(r));
              setRestored(null);
              window.history.replaceState({}, "", `/judge?d=${r.slug}&k=${r.sellerKey}`);
              setRes(r);
            } catch (e) {
              setErr(friendlyError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Creating…" : "Start my judge drop"}
        </button>
      ) : (
        <div className="row gap wrap">
          <Link className="btn btn-primary" href={`/d/${res.slug}`}>
            Fan page
          </Link>
          <Link className="btn" href={`/seller/${res.slug}?k=${res.sellerKey}`}>
            Seller console
          </Link>
          <Link className="btn" href={`/verify/${res.slug}`}>
            Verify page
          </Link>
          <Link className="btn" href={`/agent?drop=${res.slug}`}>
            Enter via AI agent
          </Link>
          <button
            className="btn btn-sm"
            onClick={() => {
              localStorage.removeItem(JUDGE_KEY);
              window.history.replaceState({}, "", "/judge");
              setRestored(null);
              setRes(null);
            }}
          >
            New drop
          </button>
        </div>
      )}
      {err && <p className="err">{err}</p>}
      <p className="muted small">Holds are {usd(4800)} in the PayPal sandbox. Nothing real is charged. Holds of anyone not selected are voided.</p>
    </section>
  );
}
