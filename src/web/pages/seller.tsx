import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiError,
  api,
  errorDetails,
  friendlyError,
  isAiSummary,
  nf,
  readSellerKey,
  realOrders,
  timeLeft,
  usd,
  type AiSummary,
  type AiUsage,
  type AnalyzeResult,
  type Cluster,
  type EventRow,
  type SellerData,
  type SellerEntry,
} from "../api";
import { Art, Hash, ShortStatus, Stat } from "../components";
import { addressDiff, addressLine, demoTracking, drawPreview, maskedAuth, pendingCopy, prettyModel, sortClusters, swarmResult } from "../console-logic";
import { AlertIcon, BeaconIcon, BotIcon, CheckIcon, DiceIcon, ExternalIcon, RefundIcon, ScaleIcon, ShieldIcon, SparkIcon, TruckIcon, UsersIcon } from "../icons";
import { Ticker, cleanEventMessage } from "../ledger";
import { Link } from "../router";
import { ConfirmDialog, SettlementSummary, ToastRegion, useToasts } from "../ui";
import { NotFound } from "./public";

const CARRIERS = ["USPS", "UPS", "FEDEX", "OTHER"] as const;

const markReviewed = (slug: string) => {
  try {
    localStorage.setItem(`paylet.reviewed.${slug}`, "1");
  } catch {
    /* ignore */
  }
};

type Dialog =
  | null
  | { kind: "draw" }
  | { kind: "ship"; entry: SellerEntry; carrier: string; tracking: string }
  | { kind: "refund"; entry: SellerEntry; reason: string };

export function SellerPage({ slug }: { slug: string }) {
  const [sellerKey] = useState(() => readSellerKey(slug));
  const [data, setData] = useState<SellerData | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState<{ code: string; text: string } | null>(null);
  const [gone, setGone] = useState(false);
  const [filter, setFilter] = useState<"all" | "real" | "simulated" | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [lastAnalyze, setLastAnalyze] = useState<AnalyzeResult | null>(null);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [requested, setRequested] = useState<Record<string, "ship" | "refund">>({});
  const { toasts, push, dismiss } = useToasts();
  const prevStatus = useRef<string | null>(null);

  const load = useCallback(async (): Promise<SellerData | null> => {
    try {
      const d = await api<SellerData>(`/api/seller/${slug}`, { sellerKey });
      setData(d);
      setErr(null);
      return d;
    } catch (e) {
      if (e instanceof ApiError && e.code === "drop_not_found") setGone(true);
      setErr({ code: e instanceof ApiError ? e.code : "error", text: friendlyError(e) });
      return null;
    }
  }, [slug, sellerKey]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [load]);

  // the draw is two-phase (freeze → drand → reveal) and settles asynchronously: say so as it happens
  const status = data?.drop.status ?? null;
  useEffect(() => {
    if (!data || !status) return;
    const prev = prevStatus.current;
    prevStatus.current = status;
    if (!prev || prev === status) return;
    const won = data.entries.filter((e) => ["won", "captured", "capture_failed"].includes(e.status)).length;
    const wl = data.entries.filter((e) => e.status === "waitlist").length;
    if (status === "drawn" && prev === "frozen")
      push({ tone: "info", text: `Drawn: ${won} winner${won === 1 ? "" : "s"}, ${wl} on the waitlist. Settling with PayPal…` });
    if (status === "settled") push({ tone: "ok", text: "Settled. Winners captured, every other hold voided: $0 charged to anyone who lost." });
  }, [status, data, push]);

  const fail = useCallback(
    (e: unknown, text?: string, action?: { label: string; onClick: () => void }) =>
      push({ tone: e instanceof ApiError && e.status === 409 ? "warn" : "bad", text: text ?? friendlyError(e), details: errorDetails(e), action }),
    [push],
  );

  const post = async <T,>(path: string, json: unknown = {}) => api<T>(`/api/seller/${slug}/${path}`, { method: "POST", sellerKey, json });

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy("");
    }
  };

  const scrollToClusters = () => document.getElementById("clusters")?.scrollIntoView({ behavior: "smooth", block: "start" });

  const swarm = () =>
    run("swarm", async () => {
      try {
        await post("swarm", { n: 12 });
        push({ tone: "info", text: "Sent 12 scalper agents. Watch the ledger." });
        await load();
      } catch (e) {
        fail(e);
      }
    });

  const simulate = () =>
    run("crowd", async () => {
      try {
        const r = await post<{ added?: number }>("simulate");
        push({ tone: "ok", text: `Added ${nf(r.added ?? 0)} simulated entrants (labelled).` });
        await load();
      } catch (e) {
        fail(e);
      }
    });

  const analyze = () =>
    run("ai", async () => {
      try {
        const t0 = Date.now();
        const r = await post<AnalyzeResult>("analyze");
        setLastAnalyze(r);
        const d = await load();
        const why = typeof r.degraded === "string" ? r.degraded : r.degraded ? (r.reason ?? "the AI didn't answer") : null;
        setDegraded(why);
        if (why) {
          push({ tone: "warn", text: "AI unavailable. Showing rule-only suggestions.", details: why, action: { label: "Retry", onClick: () => void analyze() } });
          return;
        }
        const pending = (d?.clusters ?? []).filter((c) => c.status === "suggested").length;
        const s = Math.max(1, Math.round((r.ms ?? Date.now() - t0) / 1000));
        push({
          tone: "ok",
          text: `AI reviewed ${nf(r.uncertainPairs ?? 0)} uncertain pair${r.uncertainPairs === 1 ? "" : "s"} in ${s}s: ${pending} group${pending === 1 ? "" : "s"} need${pending === 1 ? "s" : ""} your decision ↓`,
          action: pending ? { label: "Review them", onClick: scrollToClusters } : undefined,
        });
      } catch (e) {
        fail(e);
      }
    });

  const decide = (c: Cluster, decision: "confirmed" | "dismissed") =>
    run(`cluster:${c.id}`, async () => {
      try {
        await post(`clusters/${c.id}`, { decision });
        markReviewed(slug);
        const n = c.memberIds.length;
        push({ tone: "ok", text: decision === "confirmed" ? `Grouped: ${n} accounts now share one ticket.` : `Kept apart: ${n} accounts keep their own tickets.` });
        await load();
      } catch (e) {
        fail(e);
      }
    });

  const negativeTest = (on: boolean) =>
    run("neg", async () => {
      try {
        await post("negative-test", { on });
        push({
          tone: "info",
          text: on
            ? "Negative test on: PayPal will decline one winner's capture, and the unit passes to the waitlist."
            : "Negative test off: every winner's capture goes through normally.",
        });
        await load();
      } catch (e) {
        fail(e);
      }
    });

  const draw = () =>
    run("draw", async () => {
      setDialog(null);
      try {
        const r = await post<{ status?: string; winners?: unknown[]; waitlist?: unknown[]; frozenList?: unknown[]; round?: number }>("draw");
        markReviewed(slug);
        const d = await load();
        if (r.status === "frozen" || d?.drop.status === "frozen") {
          const round = d?.drop.randomness?.round;
          push({
            tone: "info",
            text: round
              ? `List frozen. Waiting for drand round ${nf(round)} (a new one every 3 s) to pick the winners…`
              : "List frozen. Waiting for public randomness (drand) to pick the winners…",
          });
        } else {
          const w = r.winners?.length ?? 0;
          const k = r.waitlist?.length ?? 0;
          push({ tone: "info", text: `Drawn: ${w} winner${w === 1 ? "" : "s"}, ${k} on the waitlist. Settling with PayPal…` });
        }
        prevStatus.current = d?.drop.status ?? prevStatus.current;
      } catch (e) {
        if (e instanceof ApiError && e.code === "pending_reviews")
          fail(e, data ? pendingCopy(data.clusters) : undefined, { label: "Review them", onClick: scrollToClusters });
        else fail(e);
      }
    });

  const ship = (entry: SellerEntry, carrier: string, tracking: string) =>
    run(`ship:${entry.id}`, async () => {
      setDialog(null);
      try {
        await post(`entries/${entry.id}/ship`, { carrier, tracking });
        setRequested((m) => ({ ...m, [entry.id]: "ship" }));
        push({
          tone: "ok",
          text:
            entry.source === "simulated"
              ? `Marked ${entry.publicId} shipped (simulated entrant: no PayPal call).`
              : `Marked ${entry.publicId} shipped: ${carrier} tracking goes to the PayPal order. Watch the ledger.`,
        });
        await load();
      } catch (e) {
        fail(e);
      }
    });

  const refund = (entry: SellerEntry, reason: string) =>
    run(`refund:${entry.id}`, async () => {
      setDialog(null);
      try {
        await post(`entries/${entry.id}/refund`, { reason: reason.trim() || "Can't ship" });
        setRequested((m) => ({ ...m, [entry.id]: "refund" }));
        push({
          tone: "ok",
          text:
            entry.source === "simulated"
              ? `Refunded ${entry.publicId} (simulated entrant: no PayPal call).`
              : `Refund of ${usd(entry.capturedCents)} requested for ${entry.publicId}. PayPal's answer shows in the ledger.`,
        });
        await load();
      } catch (e) {
        fail(e);
      }
    });

  const onEvents = useCallback(
    (events: EventRow[]) => {
      for (const e of events) {
        if (e.kind === "swarm_done") push({ tone: /rate-limited|error/i.test(e.message) ? "warn" : "ok", text: cleanEventMessage(e.message) });
        if (e.kind === "swarm_error") push({ tone: "warn", text: "The scalper swarm stopped early. Try again in a minute.", details: e.message });
      }
    },
    [push],
  );

  if (gone) return <NotFound what="drop" />;
  if (err && !data)
    return (
      <section className="card narrow">
        <p className="eyebrow">Seller console</p>
        <h2>{err.code === "seller_key_required" ? "This console needs its private link" : "Couldn't open the console"}</h2>
        <p>{err.text}</p>
        <div className="row gap wrap">
          <Link className="btn btn-primary" href="/judge">
            Go to /judge
          </Link>
          <Link className="btn" href={`/d/${slug}`}>
            Open the fan page
          </Link>
        </div>
      </section>
    );
  if (!data) return <div className="skeleton tall">Loading console…</div>;

  const { drop, entries } = data;
  const clusters = sortClusters(data.clusters);
  const aiSummary: AiSummary | null = isAiSummary(data.ai) ? data.ai : null;
  const usage: AiUsage | null = data.usage ?? (isAiSummary(data.ai) ? null : (data.ai as AiUsage));
  const model = prettyModel(aiSummary?.model ?? usage?.model);
  const aiDegraded = degraded ?? aiSummary?.degraded ?? null;
  const open = drop.status === "open" && drop.closesAt > Date.now();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const captureCents = drop.priceCents + drop.shipActualCents;

  return (
    <div className="seller">
      <section className="card seller-head">
        <Art art={drop.art} size={96} />
        <div className="grow">
          <p className="eyebrow">Seller console · {drop.maker}</p>
          <h1>{drop.title}</h1>
          <p className="muted">
            {drop.units} units · {usd(drop.priceCents)} + shipping (hold {usd(drop.priceCents + drop.shipHoldCents)}, actual {usd(drop.shipActualCents)}) ·{" "}
            {open ? `closes in ${timeLeft(drop.closesAt - Date.now())}` : STATUS_WORD[drop.status]}
          </p>
          <div className="row gap wrap">
            <Link href={`/d/${drop.slug}`} className="btn btn-sm">
              Fan page <ExternalIcon size={14} />
            </Link>
            <Link href={`/verify/${drop.slug}`} className="btn btn-sm">
              Verify page <ExternalIcon size={14} />
            </Link>
          </div>
        </div>
        <Hash label="seed commitment" value={drop.seedHash} />
      </section>

      <StatsGroups data={data} />

      <Stepper
        data={data}
        open={open}
        busy={busy}
        aiSummary={aiSummary}
        lastAnalyze={lastAnalyze}
        degraded={aiDegraded}
        onSwarm={swarm}
        onCrowd={simulate}
        onAnalyze={analyze}
        onReview={scrollToClusters}
        onDraw={() => setDialog({ kind: "draw" })}
        onNegative={negativeTest}
      />
      <p className="muted small usage">
        AI: {model}
        {usage ? ` · ${nf(usage.today)}/${nf(usage.dailyCap)} calls today` : ""}. Nothing is auto-merged: AI suggestions only take effect when you confirm them.
      </p>

      <SettlementSummary slug={drop.slug} settled={drop.status === "settled"} judge={drop.kind === "judge"} />

      <section className="card" id="clusters" aria-labelledby="clusters-title">
        <div className="card-head">
          <h3 id="clusters-title">Households &amp; reseller networks</h3>
          <span className="muted small">{clusters.filter((c) => c.status === "suggested").length} awaiting your decision</span>
        </div>
        {aiDegraded && (
          <div className="alert alert-warn alert-row" role="status" data-testid="ai-degraded">
            <AlertIcon size={16} /> <b>AI unavailable. Showing rule-only suggestions.</b>
            <span className="muted small"> {aiDegraded}</span>
            {open && (
              <button className="btn btn-sm" onClick={analyze} disabled={!!busy}>
                Retry
              </button>
            )}
          </div>
        )}
        <AiPanel ai={aiSummary} last={lastAnalyze} model={model} />
        {clusters.length === 0 && (
          <p className="muted empty">
            {aiSummary?.ranAt || lastAnalyze
              ? "No households or networks found: every account keeps its own ticket."
              : "Run the AI review (step 3) to look for accounts that belong to one household or reseller operation."}
          </p>
        )}
        <div className="clusters">
          {clusters.map((c) => (
            <ClusterCard key={c.id} c={c} byId={byId} open={open} busy={busy} model={model} onDecide={decide} />
          ))}
        </div>
      </section>

      <div className="split">
        <EntriesTable
          entries={entries}
          filter={filter}
          setFilter={setFilter}
          busy={busy}
          requested={requested}
          onShip={(e) => setDialog({ kind: "ship", entry: e, carrier: "USPS", tracking: demoTracking() })}
          onRefund={(e) => setDialog({ kind: "refund", entry: e, reason: "Can't ship" })}
        />
        <Ticker slug={drop.slug} title="Settlement ledger" traceDefault fixed onEvents={onEvents} />
      </div>

      <DrawDialog open={dialog?.kind === "draw"} data={data} clusters={clusters} captureCents={captureCents} onConfirm={draw} onClose={() => setDialog(null)} onReview={() => {
        setDialog(null);
        scrollToClusters();
      }} />
      {dialog?.kind === "ship" && (
        <ConfirmDialog open title={`Mark ${dialog.entry.publicId} as shipped?`} confirmLabel="Mark shipped" onConfirm={() => ship(dialog.entry, dialog.carrier, dialog.tracking)} onClose={() => setDialog(null)} testId="ship-dialog">
          <p>
            {dialog.entry.source === "simulated"
              ? "Simulated entrant: Paylet records the tracking without calling PayPal."
              : "Paylet adds the tracking to the PayPal order (POST /v2/checkout/orders/{id}/track), so the buyer sees it in their PayPal account."}
          </p>
          <div className="field-row">
            <label>
              Carrier
              <select value={dialog.carrier} onChange={(e) => setDialog({ ...dialog, carrier: e.target.value })}>
                {CARRIERS.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="grow">
              Tracking number
              <input value={dialog.tracking} onChange={(e) => setDialog({ ...dialog, tracking: e.target.value })} spellCheck={false} />
            </label>
          </div>
          <p className="muted small">Prefilled with a sandbox demo number.</p>
        </ConfirmDialog>
      )}
      {dialog?.kind === "refund" && (
        <ConfirmDialog
          open
          tone="danger"
          title={`Can't ship ${dialog.entry.publicId}? Refund ${usd(dialog.entry.capturedCents)}`}
          confirmLabel={`Refund ${usd(dialog.entry.capturedCents)}`}
          onConfirm={() => refund(dialog.entry, dialog.reason)}
          onClose={() => setDialog(null)}
          testId="refund-dialog"
        >
          <p>
            {dialog.entry.source === "simulated"
              ? "Simulated entrant: Paylet records the refund without calling PayPal."
              : "Paylet refunds the whole capture through PayPal (POST /v2/payments/captures/{id}/refund). The buyer owes nothing, and PayPal confirms it with a signed webhook."}
          </p>
          <label>
            Reason (the buyer sees it)
            <input value={dialog.reason} maxLength={120} onChange={(e) => setDialog({ ...dialog, reason: e.target.value })} />
          </label>
        </ConfirmDialog>
      )}
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

const STATUS_WORD: Record<string, string> = {
  open: "entries closed, drawing in a moment",
  frozen: "list frozen, waiting for public randomness",
  drawn: "drawn, settling with PayPal",
  settled: "settled",
};

// ---------------------------------------------------------------- P1-02: real vs simulated

function StatsGroups({ data }: { data: SellerData }) {
  const s = data.drop.stats;
  return (
    <section className="stats-groups" aria-label="Drop numbers">
      <div className="stats-group real" data-testid="stats-real">
        <h4>
          <span className="tag tag-real">PayPal sandbox · real</span>
        </h4>
        <div className="stats-grid">
          <Stat label="orders created" value={nf(realOrders(s))} />
          <Stat label="awaiting approval" value={nf(s.awaitingPerson)} />
          <Stat label="holds" value={nf(s.holds)} tone="good" />
          <Stat label="same-account duplicates" value={nf(s.duplicatesBlocked)} tone="warn" />
          <Stat label="captured" value={s.capturedCents != null ? usd(s.capturedCents) : nf(s.captured)} tone="good" />
          <Stat label="voided" value={s.voided != null ? nf(s.voided) : "—"} />
        </div>
      </div>
      <div className="stats-group sim" data-testid="stats-sim">
        <h4>
          <span className="tag tag-sim">Simulated · labelled</span>
        </h4>
        <div className="stats-grid">
          <Stat label="entrants" value={nf(s.simulated)} />
          <Stat label="captured (sim)" value={nf(s.capturedSimulated ?? 0)} />
          <Stat label="merged" value={nf(s.merged)} />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- P1-07: the console as five steps

type StepState = "done" | "current" | "todo" | "warn";

function Stepper(p: {
  data: SellerData;
  open: boolean;
  busy: string;
  aiSummary: AiSummary | null;
  lastAnalyze: AnalyzeResult | null;
  degraded: string | null;
  onSwarm: () => void;
  onCrowd: () => void;
  onAnalyze: () => void;
  onReview: () => void;
  onDraw: () => void;
  onNegative: (on: boolean) => void;
}) {
  const { drop, entries, clusters } = p.data;
  const sw = swarmResult(entries);
  const pending = clusters.filter((c) => c.status === "suggested").length;
  const grouped = clusters.filter((c) => c.status === "confirmed").length;
  const kept = clusters.filter((c) => c.status === "dismissed").length;
  const aiRan = !!p.aiSummary?.ranAt || !!p.lastAnalyze || clusters.length > 0;
  const off = !p.open || !!p.busy;

  const steps: { key: string; title: string; icon: ReactNode; done: boolean; warn?: boolean; result: ReactNode; action: ReactNode }[] = [
    {
      key: "swarm",
      title: "Scalper agents",
      icon: <BotIcon size={18} />,
      done: sw.links > 0,
      result: sw.links > 0 ? `${nf(sw.links)} PayPal links · ${nf(sw.holds)} holds` : "12 bots call enter_drop over MCP",
      action: (
        <button className="btn btn-step" disabled={off} onClick={p.onSwarm} data-testid="step-swarm">
          {p.busy === "swarm" ? "Sending…" : "Unleash 12 scalper agents"}
        </button>
      ),
    },
    {
      key: "crowd",
      title: "Simulated crowd",
      icon: <UsersIcon size={18} />,
      done: drop.stats.simulated > 0,
      result: drop.stats.simulated > 0 ? `${nf(drop.stats.simulated)} entrants (labelled)` : "Households + one reseller network, labelled",
      action: (
        <button className="btn btn-step" disabled={off || drop.stats.simulated > 0} onClick={p.onCrowd} data-testid="step-crowd">
          {p.busy === "crowd" ? "Adding…" : "Add simulated crowd"}
        </button>
      ),
    },
    {
      key: "ai",
      title: "AI review",
      icon: <SparkIcon size={18} />,
      done: aiRan && !p.degraded,
      warn: !!p.degraded,
      result: p.degraded
        ? "AI unavailable: rule-only suggestions"
        : p.aiSummary?.ranAt
          ? `${nf(p.aiSummary.uncertainPairs)} pairs reviewed · ${nf(p.aiSummary.linked)} linked · ${nf(p.aiSummary.keptApartCount)} kept apart`
          : aiRan
            ? `${nf(clusters.length)} group${clusters.length === 1 ? "" : "s"} found`
            : "Rules first, then the model on the fuzzy pairs",
      action: (
        <button className={`btn btn-step ${aiRan ? "" : "btn-accent"}`} disabled={off} onClick={p.onAnalyze} data-testid="step-ai">
          {p.busy === "ai" ? "AI reviewing…" : aiRan ? "Run the AI review again" : "Find households & networks"}
        </button>
      ),
    },
    {
      key: "decide",
      title: pending ? `Decide (${pending} pending)` : "Decide",
      icon: <ScaleIcon size={18} />,
      done: aiRan && pending === 0,
      result:
        pending > 0
          ? `${pending} suggestion${pending === 1 ? "" : "s"} waiting for you`
          : !aiRan
            ? "Nothing to decide yet"
            : clusters.length
              ? `All decided · ${grouped} grouped · ${kept} kept apart`
              : "Nothing to decide",
      action: (
        <button className="btn btn-step" disabled={pending === 0} onClick={p.onReview} data-testid="step-decide">
          {pending ? `Review ${pending} ↓` : "Review ↓"}
        </button>
      ),
    },
    {
      key: "draw",
      title: "Close & draw",
      icon: <DiceIcon size={18} />,
      done: drop.status === "settled",
      result:
        drop.status === "frozen" ? (
          <span className="step-live">
            <BeaconIcon size={14} /> List frozen · waiting for drand round {drop.randomness?.round ? nf(drop.randomness.round) : "…"}
          </span>
        ) : drop.status === "drawn" ? (
          <span className="step-live">Drawn · settling with PayPal…</span>
        ) : drop.status === "settled" ? (
          "Settled · report below"
        ) : (
          "Freeze the list, public randomness picks"
        ),
      action:
        drop.status === "open" ? (
          <div className="step-draw">
            <button className="btn btn-step btn-primary" disabled={off} onClick={p.onDraw} data-testid="step-draw">
              {p.busy === "draw" ? "Drawing…" : "Close & draw"}
            </button>
            <label className="toggle small">
              <input type="checkbox" checked={drop.negativeTest} disabled={off} onChange={(e) => p.onNegative(e.target.checked)} data-testid="negative-test" />
              Negative test: one winner's payment fails
            </label>
          </div>
        ) : (
          <Link className="btn btn-step" href={`/verify/${drop.slug}`}>
            Verify the draw
          </Link>
        ),
    },
  ];
  const firstOpen = steps.findIndex((s) => !s.done);
  return (
    <section className="card stepper-card" aria-labelledby="run-title">
      <div className="card-head">
        <h3 id="run-title">Run the drop</h3>
        <span className="muted small">{p.open ? "Five steps, in order. Each one shows what happened." : "Entries are closed."}</span>
      </div>
      <ol className="stepper">
        {steps.map((s, i) => {
          const state: StepState = s.done ? "done" : s.warn ? "warn" : i === firstOpen && (p.open || s.key === "draw") ? "current" : "todo";
          return (
            <li key={s.key} className={`step is-${state}`} data-testid={`step-${s.key}-row`} data-state={state} aria-current={state === "current" ? "step" : undefined}>
              <div className="step-head">
                <span className="step-n" aria-hidden="true">
                  {s.done ? <CheckIcon size={14} /> : i + 1}
                </span>
                <span className="step-icon" aria-hidden="true">
                  {s.icon}
                </span>
                <b>{s.title}</b>
                <span className="sr-only"> ({state === "done" ? "done" : state === "current" ? "next" : state === "warn" ? "needs attention" : "not yet"})</span>
              </div>
              <p className="step-result" data-testid={`step-${s.key}-result`}>
                {s.result}
              </p>
              {(p.open || s.key === "draw") && <div className="step-action">{s.action}</div>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- P2-04: what the AI did, including what it kept apart

function AiPanel({ ai, last, model }: { ai: AiSummary | null; last: AnalyzeResult | null; model: string }) {
  if (ai?.ranAt) {
    return (
      <div className="ai-panel" data-testid="ai-panel">
        <p>
          <SparkIcon size={16} /> <b>{model}</b> reviewed <b>{nf(ai.uncertainPairs)}</b> uncertain pair{ai.uncertainPairs === 1 ? "" : "s"} →{" "}
          <b>{nf(ai.linked)}</b> linked · <b>{nf(ai.keptApartCount)}</b> pair{ai.keptApartCount === 1 ? "" : "s"} kept apart
        </p>
        {ai.keptApart.length > 0 && (
          <details className="kept-apart">
            <summary>Kept apart by AI ({nf(ai.keptApartCount)})</summary>
            <ul>
              {ai.keptApart.map((k) => (
                <li key={`${k.a}-${k.b}`}>
                  <code>{k.a}</code> vs <code>{k.b}</code>: {k.reason} <span className="muted">· {Math.round(k.confidence * 100)}%</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    );
  }
  if (last && !last.degraded && last.uncertainPairs != null) {
    return (
      <div className="ai-panel" data-testid="ai-panel">
        <p>
          <SparkIcon size={16} /> <b>{model}</b> reviewed <b>{nf(last.uncertainPairs)}</b> uncertain pair{last.uncertainPairs === 1 ? "" : "s"}
          {last.llmCalls != null ? ` in ${nf(last.llmCalls)} model call${last.llmCalls === 1 ? "" : "s"}` : ""}.
        </p>
      </div>
    );
  }
  return null;
}

function AddressText({ text, normalizedKey }: { text: string; normalizedKey: string }) {
  return (
    <span className="addr">
      {addressDiff(text, normalizedKey).map((t, i) => (t.differs ? <mark key={i}>{t.text}</mark> : <span key={i}>{t.text}</span>))}
    </span>
  );
}

function ClusterCard({
  c,
  byId,
  open,
  busy,
  model,
  onDecide,
}: {
  c: Cluster;
  byId: Map<string, SellerEntry>;
  open: boolean;
  busy: string;
  model: string;
  onDecide: (c: Cluster, d: "confirmed" | "dismissed") => void;
}) {
  const pct = Math.round(c.confidence * 100);
  const ai = c.method === "ai";
  const members = c.memberIds.map((m) => byId.get(m)).filter((e): e is SellerEntry => !!e);
  return (
    <article className={`cluster cluster-${c.status} ${ai ? "cluster-ai" : ""}`} data-testid={`cluster-${c.kind}`} data-status={c.status}>
      <header>
        <span className={`badge badge-${c.kind}`}>
          {c.kind === "operator" ? "Reseller network" : "Household"} · {c.memberIds.length} accounts
        </span>
        {ai ? (
          <span className="badge badge-ai">
            <SparkIcon size={13} /> {model} · {pct}%
          </span>
        ) : (
          <span className="badge badge-rules">Rules · {pct}%</span>
        )}
        <span className="grow" />
        {c.status === "suggested" ? (
          open ? (
            <span className="cluster-actions">
              <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => onDecide(c, "confirmed")} data-testid="cluster-confirm">
                Confirm — one unit max
              </button>
              <button className="btn btn-sm" disabled={!!busy} onClick={() => onDecide(c, "dismissed")} data-testid="cluster-dismiss">
                Not the same
              </button>
            </span>
          ) : (
            <span className="pill pill-muted pill-sm pill-plain">not reviewed before the draw</span>
          )
        ) : (
          <span className={`pill pill-${c.status === "confirmed" ? "warn" : "muted"} pill-sm pill-plain`}>{c.status === "confirmed" ? "confirmed · one ticket" : "kept apart"}</span>
        )}
      </header>
      <p className={`explain ${ai ? "explain-ai" : ""}`}>{c.explanation}</p>
      {c.normalizedKey && (
        <p className="addr-key">
          <span>Normalized address</span> <code>{c.normalizedKey}</code>
        </p>
      )}
      <ul className="members">
        {members.map((e) => (
          <li key={e.id}>
            <code>{e.publicId}</code> <span className="who">{e.name ?? e.displayName ?? "—"}</span>{" "}
            {c.normalizedKey ? <AddressText text={addressLine(e.address)} normalizedKey={c.normalizedKey} /> : <span className="addr">{addressLine(e.address)}</span>}
            {e.source === "simulated" && <span className="tag tag-sim">sim</span>}
          </li>
        ))}
      </ul>
      {c.evidence.length > 0 && (
        <ul className="evidence">
          {c.evidence.map((ev, i) => (
            <li key={i}>
              <b>{ev.field}</b> {ev.detail}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

// ---------------------------------------------------------------- entries (P1-02 real first; P2-01 ship / refund)

function EntriesTable({
  entries,
  filter,
  setFilter,
  busy,
  requested,
  onShip,
  onRefund,
}: {
  entries: SellerEntry[];
  filter: "all" | "real" | "simulated" | null;
  setFilter: (f: "all" | "real" | "simulated") => void;
  busy: string;
  requested: Record<string, "ship" | "refund">;
  onShip: (e: SellerEntry) => void;
  onRefund: (e: SellerEntry) => void;
}) {
  const real = entries.filter((e) => e.source !== "simulated").length;
  const sim = entries.length - real;
  const f = filter ?? (real > 0 ? "real" : "all");
  const counts = { all: entries.length, real, simulated: sim };
  const visible = entries.filter((e) => (f === "all" ? true : f === "real" ? e.source !== "simulated" : e.source === "simulated"));
  return (
    <section className="card entries" aria-labelledby="entries-title">
      <div className="card-head">
        <h3 id="entries-title">Entries</h3>
        <div className="seg" role="group" aria-label="Show entries">
          {(["all", "real", "simulated"] as const).map((k) => (
            <button key={k} className={f === k ? "on" : ""} aria-pressed={f === k} onClick={() => setFilter(k)} data-testid={`filter-${k}`}>
              {k === "all" ? "All" : k === "real" ? "Real" : "Simulated"} {nf(counts[k])}
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
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="muted empty">
                  {entries.length === 0 ? "No entries yet. Enter from the fan page, or run step 1 or 2." : "Nothing in this filter."}
                </td>
              </tr>
            )}
            {sortEntries(visible).map((e) => {
                const isSim = e.source === "simulated";
                const auth = maskedAuth(e);
                const req = requested[e.id];
                return (
                  <tr key={e.id} className={isSim ? "sim" : "real"} data-testid="entry-row" data-status={e.status}>
                    <td>
                      <code>{e.publicId}</code>
                      {auth && (
                        <small className="auth" title="PayPal authorization (masked)">
                          {auth}
                        </small>
                      )}
                    </td>
                    <td>
                      {isSim ? (
                        <span className="tag tag-sim">simulated</span>
                      ) : e.source === "agent" ? (
                        <span className="tag tag-agent">{e.agentLabel ?? "agent"}</span>
                      ) : (
                        <span className="tag tag-real">person</span>
                      )}
                      {e.payerVerified && (
                        <span className="verified" title="PayPal-verified payer">
                          <ShieldIcon size={14} label="PayPal-verified payer" />
                        </span>
                      )}
                    </td>
                    <td>{e.displayName ?? "—"}</td>
                    <td className="small">{e.address ? `${e.address.city ?? ""} ${e.address.state ?? ""} ${e.address.zip ?? ""}`.trim() : "—"}</td>
                    <td className="num">
                      {usd(e.holdCents)}
                      {isSim && e.holdCents != null ? <span className="muted"> (sim)</span> : null}
                    </td>
                    <td>
                      <span className={isSim ? "pill-sim-wrap" : ""}>
                        <ShortStatus status={e.status} />
                      </span>
                      {e.shipping && (
                        <small className="shipped">
                          <TruckIcon size={13} /> {e.shipping.carrier} …{e.shipping.tracking.slice(-4)}
                        </small>
                      )}
                    </td>
                    <td className="row-actions">
                      {e.status === "captured" &&
                        (req && !e.shipping && req === "ship" ? (
                          <span className="muted small">Sending to PayPal…</span>
                        ) : req === "refund" ? (
                          <span className="muted small">Refunding…</span>
                        ) : (
                          <>
                            {!e.shipping && (
                              <button className="btn btn-xs" disabled={!!busy} onClick={() => onShip(e)} data-testid="ship">
                                <TruckIcon size={13} /> Mark shipped
                              </button>
                            )}
                            {!e.shipping && (
                              <button className="btn btn-xs btn-ghost-bad" disabled={!!busy} onClick={() => onRefund(e)} data-testid="refund">
                                <RefundIcon size={13} /> Refund {usd(e.capturedCents)}
                              </button>
                            )}
                          </>
                        ))}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Money first: captured/selected, then live holds, then released, then no-hold rows; newest first within each. */
const RANK: Record<string, number> = { captured: 0, won: 0, capture_failed: 0, refunded: 0, held: 1, waitlist: 1, authorizing: 1, voided: 2, lost: 2, merged: 3, duplicate: 3 };
function sortEntries(list: SellerEntry[]): SellerEntry[] {
  return list
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (RANK[a.e.status] ?? 4) - (RANK[b.e.status] ?? 4) || (a.e.source === "simulated" ? 1 : 0) - (b.e.source === "simulated" ? 1 : 0) || b.i - a.i)
    .map((x) => x.e);
}

// ---------------------------------------------------------------- P0-03: confirm before the draw

function DrawDialog({
  open,
  data,
  clusters,
  captureCents,
  onConfirm,
  onClose,
  onReview,
}: {
  open: boolean;
  data: SellerData;
  clusters: Cluster[];
  captureCents: number;
  onConfirm: () => void;
  onClose: () => void;
  onReview: () => void;
}) {
  const { drop, entries } = data;
  const pending = clusters.filter((c) => c.status === "suggested").length;
  const pv = drawPreview(entries, drop.units, captureCents);
  const blocked = pending > 0 || pv.eligible === 0;
  return (
    <ConfirmDialog
      open={open}
      title={pending > 0 ? "Review the AI suggestions first" : pv.eligible === 0 ? "Nothing to draw yet" : "Close the drop for good?"}
      confirmLabel={pending > 0 ? "Review them" : pv.eligible === 0 ? "Got it" : "Close & draw"}
      onConfirm={pending > 0 ? onReview : blocked ? onClose : onConfirm}
      onClose={onClose}
      testId="draw-dialog"
    >
      {pending > 0 ? (
        <p className="alert alert-warn" data-testid="draw-pending">
          {pendingCopy(clusters)}
        </p>
      ) : pv.eligible === 0 ? (
        <p>Nobody in this drop has a PayPal hold yet, so there's nothing to draw. Enter from the fan page, or add the simulated crowd.</p>
      ) : (
        <>
          <p data-testid="draw-copy">
            This captures {pv.winners} winner{pv.winners === 1 ? "" : "s"} (≈ {usd(pv.cents)}) and releases every other hold.
          </p>
          <p className="muted small">
            {nf(pv.eligible)} entries hold a ticket. The list is frozen first; then a public drand round picks the winners, so nobody, Paylet included, knows them
            in advance.
          </p>
          {drop.negativeTest && <p className="alert alert-warn small">Negative test is on: PayPal will decline one winner's capture, and the unit passes to the waitlist.</p>}
        </>
      )}
    </ConfirmDialog>
  );
}
