import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, api, clock, friendlyError, nf, timeLeft, usd, type PaypalCheck, type PublicDrop, type VerifyData } from "../api";
import { HashFull } from "../components";
import { BeaconIcon, CheckIcon, ClockIcon, CommitIcon, CrossIcon, DiceIcon, DownloadIcon, SnowIcon } from "../icons";
import { Link } from "../router";
import { canonicalList, computeDraw, sha256Hex } from "../../shared/draw";
import { QUICKNET_HASH, quicknetRoundTime, reconcile, type Reconciliation, type ReconciledRow } from "../verify-logic";
import { NotFound } from "./public";

// ---------------------------------------------------------------- /verify/:slug — re-run the draw in the browser, then ask PayPal

interface RunResult {
  seedOk: boolean;
  listOk: boolean;
  /** null = this drop has no public randomness (older drops) */
  drand: null | { fetched: boolean; matches: boolean; finalOk: boolean; round: number; error?: string };
  rec: Reconciliation;
}

const markVerified = (slug: string) => {
  try {
    localStorage.setItem(`paylet.verified.${slug}`, "1");
  } catch {
    /* ignore */
  }
};

export function VerifyPage({ slug }: { slug: string }) {
  const [d, setD] = useState<VerifyData | null>(null);
  const [drop, setDrop] = useState<PublicDrop | null>(null);
  const [missing, setMissing] = useState(false);
  const [res, setRes] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const [v, p] = await Promise.all([api<VerifyData>(`/api/drops/${slug}/verify`), api<PublicDrop>(`/api/drops/${slug}`).catch(() => null)]);
      setD(v);
      if (p) setDrop(p);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
    }
  }, [slug]);
  useEffect(() => {
    void load();
  }, [load]);
  // while the drop is open or waiting for randomness, keep the page live
  const waiting = !d || d.status === "open" || d.status === "frozen" || d.status === "drawn";
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => {
      setNow(Date.now());
      void load();
    }, 3000);
    return () => clearInterval(t);
  }, [waiting, load]);

  const run = async () => {
    if (!d?.seed || !d.frozenList) return;
    setRunning(true);
    try {
      const seedOk = (await sha256Hex(d.seed)) === d.seedHash;
      const listOk = (await sha256Hex(canonicalList(d.frozenList))) === d.frozenHash;
      let drawSeed = d.seed;
      let drand: RunResult["drand"] = null;
      const r = d.randomness;
      if (r && r.value) {
        let value = r.value;
        let fetched = false;
        let matches = false;
        let error: string | undefined;
        try {
          const j = (await fetch(r.url, { cache: "no-store" }).then((x) => x.json())) as { round?: number; randomness?: string };
          fetched = true;
          matches = j.round === r.round && j.randomness === r.value;
          if (j.randomness) value = j.randomness;
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        const final = await sha256Hex(`${d.seed}:${value}`);
        drawSeed = final;
        drand = { fetched, matches, finalOk: final === d.finalSeed, round: r.round, error };
      }
      const draw = await computeDraw(drawSeed, d.frozenList, d.units, d.waitlistSize);
      setRes({
        seedOk,
        listOk,
        drand,
        rec: reconcile(
          draw.ranking.map((x) => x.publicId),
          d.units,
          d.waitlistSize,
          d.outcome,
        ),
      });
      markVerified(slug);
    } finally {
      setRunning(false);
    }
  };

  if (missing) return <NotFound what="drop" />;
  if (!d) return <div className="skeleton tall">Loading…</div>;
  const closesAt = d.closesAt ?? drop?.closesAt ?? null;
  const n = d.frozenList?.length ?? 0;

  return (
    <div className="verify-page">
      <section className="card verify">
        <p className="eyebrow">Verify the draw</p>
        <h2>{d.title}</h2>
        <p className="muted">
          {d.units} unit{d.units === 1 ? "" : "s"} · {d.frozenList ? `${n} eligible entries` : "entries still open"} · waitlist of {d.waitlistSize}
          {drop?.kind === "proof" && <span className="tag tag-real">real PayPal sandbox run</span>}
        </p>

        <DrawTimeline d={d} />

        {d.status === "open" && (
          <div className="alert" role="status">
            <ClockIcon size={16} /> Draw at {closesAt ? clock(closesAt) : "close"}: the seed stays secret until then.
            {closesAt && closesAt > now && <b className="countdown"> {timeLeft(closesAt - now)}</b>}
          </div>
        )}
        {d.status === "frozen" && (
          <div className="alert" role="status">
            <BeaconIcon size={16} /> List frozen.{" "}
            {d.randomness ? <>Waiting for drand round {nf(d.randomness.round)} (a new round is published every 3 s)…</> : <>Waiting for public randomness…</>}
          </div>
        )}

        <div className="hashes">
          <HashFull label="Seed commitment · SHA-256(seed), published at open" value={d.seedHash} />
          <HashFull label="Revealed seed" value={d.seed} hint={d.seed ? undefined : "Revealed at the draw."} />
          <HashFull
            label="Frozen eligible list · SHA-256 of the sorted entry ids, one per line"
            value={d.frozenHash}
            hint={d.frozenHash ? undefined : "Published when entries close."}
          />
          {d.randomness && (
            <HashFull
              label={`drand quicknet round ${nf(d.randomness.round)} · randomness`}
              value={d.randomness.value}
              hint={d.randomness.value ? undefined : "Not published yet. Paylet committed to this round when it froze the list."}
            />
          )}
          {d.randomness && <HashFull label="Final seed · SHA-256(seed:randomness)" value={d.finalSeed ?? null} />}
        </div>

        {d.status !== "open" && (
          <>
            <div className="row gap wrap">
              <button className="btn btn-primary" onClick={run} disabled={!d.seed || !d.frozenList || running || (!!d.randomness && !d.randomness.value)}>
                {running ? "Re-running…" : "Re-run the draw here"}
              </button>
              {d.frozenList && (
                <button className="btn" onClick={() => downloadFrozen(slug, d)}>
                  <DownloadIcon size={16} /> Download frozen list (JSON)
                </button>
              )}
            </div>
            <p className="muted small">
              Runs the same code the server used (<code>src/shared/draw.ts</code>) in your browser: rank = SHA-256({d.randomness ? "final seed" : "seed"}:entry
              id), lowest first. The first {d.units} win; the next {d.waitlistSize} form the waitlist.
            </p>
          </>
        )}

        {res && <Results d={d} res={res} />}
      </section>

      <AskPayPal slug={slug} />
    </div>
  );
}

function DrawTimeline({ d }: { d: VerifyData }) {
  const r = d.randomness;
  const roundTime = r && r.chainHash === QUICKNET_HASH ? quicknetRoundTime(r.round) : null;
  const nodes: { icon: ReactNode; title: string; detail: ReactNode; state: "done" | "wait" | "off" }[] = [
    { icon: <CommitIcon size={18} label="Commit" />, title: "Commit", detail: <>SHA-256(seed) published when the drop opened</>, state: "done" },
    {
      icon: <SnowIcon size={18} label="Freeze" />,
      title: "Freeze",
      detail: d.frozenHash ? (
        <>
          {d.frozenList?.length ?? 0} eligible entries, list hashed{d.excluded?.length ? `, ${d.excluded.length} excluded` : ""}
        </>
      ) : (
        <>at close</>
      ),
      state: d.frozenHash ? "done" : "wait",
    },
    r
      ? {
          icon: <BeaconIcon size={18} label="Public randomness" />,
          title: `drand round ${nf(r.round)}`,
          detail: r.value ? <>published{roundTime ? ` ${clock(roundTime, true)}` : ""}, after the freeze</> : <>chosen at the freeze, not published yet</>,
          state: r.value ? "done" : "wait",
        }
      : {
          icon: <BeaconIcon size={18} label="Public randomness" />,
          title: "Public randomness",
          detail: d.status === "open" ? <>a future drand round, fixed at the freeze</> : <>not used by this drop (seed only)</>,
          state: d.status === "open" ? "wait" : "off",
        },
    {
      icon: <DiceIcon size={18} label="Reveal" />,
      title: "Reveal",
      detail: d.seed ? <>seed revealed, winners ranked</> : <>at the draw</>,
      state: d.seed ? "done" : "wait",
    },
  ];
  return (
    <ol className="vtl" aria-label="Draw timeline">
      {nodes.map((x) => (
        <li key={x.title} className={`vtl-node is-${x.state}`}>
          <span className="vtl-icon">{x.icon}</span>
          <b>{x.title}</b>
          <small>{x.detail}</small>
        </li>
      ))}
    </ol>
  );
}

function Check({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  return (
    <li className={`check-row ${ok === true ? "is-ok" : ok === false ? "is-bad" : "is-wait"}`}>
      <span className="check-icon">
        {ok === true ? <CheckIcon size={16} label="passed" /> : ok === false ? <CrossIcon size={16} label="failed" /> : <ClockIcon size={16} label="pending" />}
      </span>
      <span>{children}</span>
    </li>
  );
}

function Results({ d, res }: { d: VerifyData; res: RunResult }) {
  const { rec } = res;
  return (
    <div className="verify-res" aria-live="polite">
      <ul className="checks">
        <Check ok={res.seedOk}>
          {res.seedOk ? "SHA-256(seed) matches the commitment published before entries opened." : "The revealed seed does NOT match the commitment."}
        </Check>
        <Check ok={res.listOk}>
          {res.listOk ? "The eligible list matches the hash frozen before the reveal." : "The eligible list does NOT match the frozen hash."}
        </Check>
        {res.drand && (
          <Check ok={res.drand.fetched ? res.drand.matches && res.drand.finalOk : null}>
            {res.drand.fetched ? (
              res.drand.matches && res.drand.finalOk ? (
                <>
                  drand round {nf(res.drand.round)}, fetched by your browser from <a href={d.randomness!.url}>the League of Entropy relay</a>, matches the
                  randomness Paylet used, and SHA-256(seed:randomness) gives the recorded final seed.
                </>
              ) : (
                <>
                  drand round {nf(res.drand.round)} does NOT match what Paylet recorded{res.drand.finalOk ? "" : " (final seed differs)"}.
                </>
              )
            ) : (
              <>
                Your browser couldn't reach drand ({res.drand.error}); recomputed with the value Paylet recorded. Open <a href={d.randomness!.url}>the round</a>{" "}
                to compare.
              </>
            )}
          </Check>
        )}
        <Check ok={rec.consistent}>
          {rec.consistent === true
            ? "Recorded outcome is consistent with your computation."
            : rec.consistent === false
              ? "Recorded outcome does NOT follow from your computation."
              : "Settlement is still in progress. Re-run once the drop is settled to check the recorded outcome."}
        </Check>
      </ul>
      {rec.problems.length > 0 && (
        <ul className="problems">
          {rec.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="table-wrap">
        <table className="rank-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Entry</th>
              <th>Your computation</th>
              <th>Recorded outcome</th>
            </tr>
          </thead>
          <tbody>
            {rec.rows.map((r) => (
              <tr
                key={r.publicId}
                className={`${r.computed.kind === "winner" ? "is-winner" : r.computed.kind === "waitlist" ? "is-wait" : ""} ${r.verdict === "bad" ? "is-bad" : ""}`}
              >
                <td className="num">{r.rank}</td>
                <td>
                  <code>{r.publicId}</code>
                </td>
                <td>
                  {r.computed.kind === "winner" ? (
                    <b>Winner #{r.computed.n}</b>
                  ) : r.computed.kind === "waitlist" ? (
                    `Waitlist #${r.computed.n}`
                  ) : (
                    <span className="muted">Not selected</span>
                  )}
                </td>
                <td>
                  <Outcome r={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.excluded && d.excluded.length > 0 && (
        <p className="muted small">
          Excluded before the freeze:{" "}
          {d.excluded.map((x, i) => (
            <span key={x.publicId}>
              {i > 0 && ", "}
              <code>{x.publicId}</code> ({x.reason === "duplicate" ? "same PayPal account" : x.reason === "merged" ? "merged household/network" : x.reason})
            </span>
          ))}
          .
        </p>
      )}
    </div>
  );
}

function Outcome({ r }: { r: ReconciledRow }) {
  const st = r.recorded?.status;
  const mark = r.verdict === "ok" ? <span className="ok-mark">✓</span> : r.verdict === "bad" ? <span className="bad-mark">✗</span> : null;
  if (r.passedTo)
    return (
      <span>
        <span className="bad-mark">✗</span> payment failed → waitlist #{r.passedTo.waitlistN} <code>{r.passedTo.publicId}</code>{" "}
        <span className="ok-mark">✓</span>
      </span>
    );
  const label: Record<string, string> = {
    captured: r.tookFrom ? `Captured (took the unit of ${r.tookFrom})` : "Captured",
    won: "Selected, capturing…",
    refunded: "Captured, later refunded",
    capture_failed: "Payment failed",
    voided: "Voided · $0",
    lost: "Releasing hold · $0",
    waitlist: "Waitlist, not needed yet",
    held: "Hold placed",
  };
  return (
    <span>
      {st ? (label[st] ?? st.replace(/_/g, " ")) : <span className="muted">Not charged</span>} {mark}
      {r.recorded?.note && <small className="muted"> · {r.recorded.note}</small>}
    </span>
  );
}

function downloadFrozen(slug: string, d: VerifyData) {
  const body = {
    drop: slug,
    title: d.title,
    units: d.units,
    waitlistSize: d.waitlistSize,
    seedHash: d.seedHash,
    seed: d.seed,
    frozenHash: d.frozenHash,
    canonicalForm: "entry ids sorted, joined with \\n; frozenHash = SHA-256 of that string",
    frozenList: d.frozenList,
    excluded: d.excluded ?? [],
    randomness: d.randomness ?? null,
    finalSeed: d.finalSeed ?? null,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `paylet-${slug}-frozen-list.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- P1-03: Ask PayPal now

function moneyLine(row: PaypalCheck["rows"][number]): string {
  switch (row.paypalStatus) {
    case "CAPTURED":
    case "PARTIALLY_CAPTURED":
      return `${usd(row.capturedCents)} of ${usd(row.heldCents)} captured`;
    case "CREATED":
    case "PENDING":
      return `${usd(row.heldCents)} on hold, nothing charged`;
    default:
      return row.capturedCents ? `${usd(row.capturedCents)} captured` : "$0 charged";
  }
}

function AskPayPal({ slug }: { slug: string }) {
  const [state, setState] = useState<{ busy: boolean; data: PaypalCheck | null; err: string }>({ busy: false, data: null, err: "" });
  const ask = async () => {
    setState((s) => ({ ...s, busy: true, err: "" }));
    try {
      const data = await api<PaypalCheck>(`/api/drops/${slug}/paypal-check`);
      setState({ busy: false, data, err: "" });
      markVerified(slug);
    } catch (e) {
      const err =
        e instanceof ApiError && e.code === "not_available"
          ? "This server doesn't offer the live PayPal check yet."
          : e instanceof ApiError && e.code === "rate_limited"
            ? "PayPal checks are limited to a few per minute. Try again shortly."
            : e instanceof ApiError && e.code === "paypal_error"
              ? "PayPal didn't answer just now. Try again in a moment."
              : friendlyError(e);
      setState((s) => ({ ...s, busy: false, err }));
    }
  };
  const { data } = state;
  return (
    <section className="card ask-paypal" aria-labelledby="ask-title" id="ask-paypal">
      <div className="card-head">
        <h3 id="ask-title">Settlement checked against PayPal</h3>
        <span className="tag tag-real">live PayPal sandbox API</span>
      </div>
      <p>
        "Losers are never charged" shouldn't rest on our word. Paylet asks PayPal for the current status of every real hold in this drop (
        <code>GET /v2/payments/authorizations/{"{id}"}</code>) and compares it with its own ledger. Simulated entrants never touch PayPal, so they aren't
        listed.
      </p>
      <div className="row gap wrap">
        <button className="btn btn-primary" onClick={ask} disabled={state.busy}>
          {state.busy ? "Asking PayPal…" : data ? "Ask PayPal again" : "Ask PayPal now"}
        </button>
        {data && <span className="muted small">Checked with PayPal at {clock(data.checkedAt, true)} · answers are cached for up to 60 s</span>}
      </div>
      {state.err && (
        <p className="alert" role="status">
          {state.err}
        </p>
      )}
      {data &&
        (data.rows.length === 0 ? (
          <p className="muted">This drop has no real PayPal holds to check (only simulated entrants, or nobody approved yet).</p>
        ) : (
          <>
            <ul className="pp-rows">
              {data.rows.map((row) => (
                <li key={row.publicId} className={row.matchesLedger ? "" : "is-bad"}>
                  <code>{row.publicId}</code>
                  <span>
                    PayPal says <b>{row.paypalStatus}</b>
                  </span>
                  <span>{moneyLine(row)}</span>
                  <span className={row.matchesLedger ? "ok-mark" : "bad-mark"}>
                    {row.matchesLedger ? "✓ matches our ledger" : `✗ our ledger says ${row.ledgerStatus}`}
                  </span>
                  <small className="muted">authorization {row.authorization}</small>
                </li>
              ))}
            </ul>
            <p className={`small ${data.totals.mismatches ? "err" : "muted"}`}>
              {data.totals.captured} captured · {data.totals.voided} voided · {data.totals.mismatches} mismatch{data.totals.mismatches === 1 ? "" : "es"} with
              our ledger
            </p>
          </>
        ))}
      <p className="muted small">
        Want the whole story? <Link href={`/d/${slug}`}>The drop's public ledger</Link> shows every PayPal call as it happened.
      </p>
    </section>
  );
}
