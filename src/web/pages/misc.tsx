import { useEffect, useState } from "react";
import { api } from "../api";

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
