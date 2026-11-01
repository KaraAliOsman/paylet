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

interface Stat { mean: number; sd: number; min: number; max: number }
interface Failure { kind: string; pairsAffected?: number; runCount?: number; runs?: number; analysis?: string }
interface Section { dataset: { entries: number; groups: number; sha256: string; generator: string; frozenAt?: string }; results: EvalRow[]; failures?: Failure[] }

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const REPO_EVALS = "https://github.com/KaraAliOsman/paylet/blob/main/docs/EVALS.md";

function EvalTable({ rows, heldOut }: { rows: EvalRow[]; heldOut?: { precision: Stat; recall: Stat; f1: Stat; falseMerges: Stat } }) {
  return (
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
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const paylet = r.system.startsWith("Paylet");
            const sd = (s?: Stat) => (paylet && s ? <small className="muted"> ± {(s.sd * 100).toFixed(1)}</small> : null);
            return (
              <tr key={r.system} className={paylet ? "hl" : ""}>
                <td>{r.system}</td>
                <td>
                  {pct(r.precision)}
                  {sd(heldOut?.precision)}
                </td>
                <td>
                  {pct(r.recall)}
                  {sd(heldOut?.recall)}
                </td>
                <td>
                  <b>{pct(r.f1)}</b>
                  {sd(heldOut?.f1)}
                </td>
                <td>
                  {Number.isInteger(r.falseMerges) ? r.falseMerges : r.falseMerges.toFixed(1)}
                  {paylet && heldOut ? <small className="muted"> (worst {heldOut.falseMerges.max})</small> : null}
                </td>
                <td>{Number.isInteger(r.missedLinks) ? r.missedLinks : r.missedLinks.toFixed(1)}</td>
                <td>{r.llmCalls}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function EvalsPage() {
  const [d, setD] = useState<
    | ({
        available: boolean;
        results?: EvalRow[];
        dataset?: Section["dataset"];
        heldOut?: Section | null;
        headline?: { falseMergesRulesDev: number; heldOut?: { precision: Stat; recall: Stat; f1: Stat; falseMerges: Stat; falseMergesRules: number; failures: number; failuresExplained: number } };
        runs?: number;
        ranAt?: string;
        model?: string;
      })
    | null
  >(null);
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
  const ho = d.heldOut;
  const hh = d.headline?.heldOut;
  return (
    <div className="evals-page">
      <section className="card evals">
        <p className="eyebrow">Measured, not vibes</p>
        <h2>Can the AI tell a household from a reseller?</h2>
        <p className="lede">
          A false merge costs a real fan their chance, so we measure it. Every number below can be reproduced offline with <code>pnpm evals --replay</code>{" "}
          (each model answer is recorded). In production nothing is auto-merged: the seller confirms and fans can appeal.
        </p>
        {ho && hh && (
          <>
            <div className="card-head">
              <h3>Held-out set · blind</h3>
              <span className="tag tag-real">generated after the rules and prompt were frozen</span>
            </div>
            <p className="small">
              <b>{ho.dataset.entries}</b> PayPal accounts in <b>{ho.dataset.groups}</b> true people or operations: {ho.dataset.generator}. SHA-256{" "}
              <code>{ho.dataset.sha256.slice(0, 16)}…</code>. Paylet row: mean of {d.runs ?? 3} independent model runs ± standard deviation.
            </p>
            <EvalTable rows={ho.results} heldOut={hh} />
            <p className="evals-take">
              Against rules alone, the model cuts false merges from <b>{hh.falseMergesRules}</b> to <b>{hh.falseMerges.mean.toFixed(1)}</b> on data it never saw. It is
              not perfect: <b>{hh.failures}</b> failure modes remain, and all <b>{hh.failuresExplained}</b> are explained below. These are the numbers from before any fix, so they stay blind.
            </p>
            {ho.failures && ho.failures.length > 0 && (
              <ol className="failures">
                {ho.failures.map((f, i) => (
                  <li key={i}>
                    <span className={`tag ${f.kind === "false_merge" ? "tag-bad" : "tag-sim"}`}>{f.kind === "false_merge" ? "false merge" : "missed link"}</span>
                    <span>{f.analysis}</span>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </section>
      <section className="card evals">
        <div className="card-head">
          <h3>Development set</h3>
          <span className="tag tag-sim">used while building the rules: expect it to look better</span>
        </div>
        <p className="small">
          <b>{d.dataset!.entries}</b> PayPal accounts in <b>{d.dataset!.groups}</b> true people or operations ({d.dataset!.generator}). SHA-256{" "}
          <code>{d.dataset!.sha256.slice(0, 16)}…</code>.
        </p>
        <EvalTable rows={d.results!} />
        <p className="muted small">
          Model: {d.model} · recorded {d.ranAt?.slice(0, 16).replace("T", " ")} UTC. Full method, every failure and the generators:{" "}
          <a href={REPO_EVALS} target="_blank" rel="noopener">
            docs/EVALS.md
          </a>
          .
        </p>
      </section>
    </div>
  );
}
