import { useEffect, useState } from "react";
import { ApiError, api, friendlyError, usd } from "../api";
import { Hash } from "../components";
import { Link } from "../router";
import { canonicalList, computeDraw, sha256Hex } from "../../shared/draw";

// ---------------------------------------------------------------- Verify (runs the shared draw code in the browser)

interface VerifyData {
  title: string;
  status: string;
  units: number;
  waitlistSize: number;
  seedHash: string;
  seed: string | null;
  frozenHash: string | null;
  frozenList: string[] | null;
  outcome: { publicId: string; status: string }[];
}

export function VerifyPage({ slug }: { slug: string }) {
  const [d, setD] = useState<VerifyData | null>(null);
  const [missing, setMissing] = useState(false);
  const [res, setRes] = useState<{ seedOk: boolean; listOk: boolean; winners: string[]; waitlist: string[] } | null>(null);
  useEffect(() => {
    void api<VerifyData>(`/api/drops/${slug}/verify`)
      .then(setD)
      .catch((e) => e instanceof ApiError && e.status === 404 && setMissing(true));
  }, [slug]);
  const run = async () => {
    if (!d?.seed || !d.frozenList) return;
    const seedOk = (await sha256Hex(d.seed)) === d.seedHash;
    const listOk = (await sha256Hex(canonicalList(d.frozenList))) === d.frozenHash;
    const r = await computeDraw(d.seed, d.frozenList, d.units, d.waitlistSize);
    setRes({ seedOk, listOk, winners: r.winners, waitlist: r.waitlist });
  };
  if (missing) return <section className="card narrow"><h2>Drop not found</h2><p>The public demo resets its data after it sleeps. <Link href="/judge">Start a fresh judge drop</Link>.</p></section>;
  if (!d) return <div className="skeleton tall">Loading…</div>;
  const actual = new Set(d.outcome.map((o) => o.publicId));
  return (
    <section className="card narrow verify">
      <p className="eyebrow">Verify the draw</p>
      <h2>{d.title}</h2>
      <Hash label="Seed commitment (published at open)" value={d.seedHash} />
      <Hash label="Revealed seed" value={d.seed} />
      <Hash label="Frozen eligible list hash" value={d.frozenHash} />
      {d.status === "open" ? (
        <p className="muted">The draw hasn't happened yet. The seed stays secret until the list is frozen.</p>
      ) : (
        <>
          <p>
            {d.frozenList?.length} eligible entries · {d.units} units. This page re-computes everything in your browser with the same code the server used:
            rank = SHA-256(seed:entryId).
          </p>
          <button className="btn btn-primary" onClick={run}>
            Re-run the draw here
          </button>
          {res && (
            <div className="verify-res">
              <p>{res.seedOk ? "✅ SHA-256(seed) matches the commitment published before entries opened." : "❌ Seed does not match commitment."}</p>
              <p>{res.listOk ? "✅ The eligible list matches the hash frozen before the reveal." : "❌ List hash mismatch."}</p>
              <p>
                Winners by your computation: {res.winners.map((w) => <code key={w}>{w} </code>)}
              </p>
              <p className="muted small">
                Waitlist: {res.waitlist.join(", ") || "—"}. Paid outcome on record: {[...actual].join(", ") || "—"} (a waitlisted entry replaces a winner only if that winner's
                payment failed).
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

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
  const [d, setD] = useState<{ available: boolean; dataset?: { entries: number; groups: number; sha256: string; generator: string }; results?: EvalRow[]; byKind?: Record<string, Record<string, number>>; ranAt?: string; model?: string; notes?: string[] } | null>(null);
  useEffect(() => {
    void api<typeof d>("/api/evals").then(setD);
  }, []);
  if (!d) return <div className="skeleton tall">Loading…</div>;
  if (!d.available) return <section className="card narrow"><h2>Evals</h2><p>No eval run published yet.</p></section>;
  return (
    <section className="card evals">
      <p className="eyebrow">Measured, not vibes</p>
      <h2>Entity-resolution evals</h2>
      <p>
        Frozen adversarial dataset: <b>{d.dataset!.entries}</b> PayPal-account entries in <b>{d.dataset!.groups}</b> true people/operations ({d.dataset!.generator}).
        SHA-256 <code>{d.dataset!.sha256.slice(0, 16)}…</code>. Pairwise metrics: a "link" means "these two accounts should share one allocation".
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
        Model: {d.model} · run {d.ranAt}. Reproduce: <code>pnpm evals</code>. A false merge costs a real fan their chance, so Paylet never auto-merges — the seller confirms.
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

// ---------------------------------------------------------------- How it works

export function HowPage() {
  return (
    <section className="card narrow prose">
      <h2>How Paylet works</h2>
      <h3>PayPal is the allocation key</h3>
      <p>
        Every entry is a PayPal Orders v2 order with <code>intent: AUTHORIZE</code>. When the person approves, Paylet reads <code>payer.payer_id</code> from PayPal's own
        order record (server-side, never trusted from the browser), stores only an HMAC of it, and enforces a unique constraint per drop before calling{" "}
        <code>/authorize</code>. A second approval from the same account simply never gets a hold.
      </p>
      <h3>Agents welcome, people pay</h3>
      <p>
        Paylet exposes an MCP server. An AI agent can list drops and request an entry, receiving a PayPal approval link. It cannot approve: the hold only exists once a
        person approves in PayPal.
      </p>
      <h3>AI where rules run out</h3>
      <p>
        Deterministic normalisation (USPS-style suffixes, unit designators, c/o, mailbox aliases) links the obvious cases. Only fuzzy pairs go to the model (MiMo V2.6
        Pro, structured output), which must cite concrete fields. Nothing is auto-merged: the seller confirms, and fans can appeal.
      </p>
      <h3>Verifiable draw and honest settlement</h3>
      <p>
        The seed's SHA-256 is published at open; the eligible list is frozen and hashed before the reveal. Winners are captured (only real shipping — partial capture),
        everyone else is voided. If a winner's payment fails, the next waitlisted entry — whose hold already exists — takes the unit. Every PayPal call goes through a
        persistent, throttled queue whose key is the <code>PayPal-Request-Id</code>, so a retry can never double-charge.
      </p>
      <h3>What this does NOT guarantee</h3>
      <ul>
        <li>A PayPal account is not proof of a unique human; one person can hold several accounts. Paylet raises the cost, it does not make scalping impossible.</li>
        <li>The seller could collude with a reseller; the frozen-list hash makes after-the-fact changes detectable, not impossible.</li>
        <li>PayPal authorizations have a 3-day honor period, so drops close within 48 hours.</li>
      </ul>
    </section>
  );
}
