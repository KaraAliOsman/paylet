import { useEffect, useState, type ReactNode } from "react";
import { ApiError, api, apiOptional, clock, friendlyError, nf, sellerHref, timeLeft, usd, type JudgeBuyer, type ProofInfo, type PublicDrop } from "../api";
import { CopyButton } from "../components";
import { BotIcon, CheckIcon, ClockIcon, EyeIcon, KeyIcon, ShieldIcon, TerminalIcon } from "../icons";
import { Link } from "../router";

// ---------------------------------------------------------------- /judge: a live checklist (P1-06) that never hands out dead links (P0-05)

export const JUDGE_KEY = "paylet.judge";
const CODE_KEY = "paylet.judgeCode";

interface JudgeDrop {
  slug: string;
  sellerKey: string;
}

const store = {
  get<T>(k: string): T | null {
    try {
      return JSON.parse(localStorage.getItem(k) ?? "null") as T | null;
    } catch {
      return null;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  },
  del(k: string) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

/** /judge?code=…#d=<slug>&k=<key>: the drop rides in the fragment (never sent to a server); ?d=&k= still works. */
function judgeUrl(res: JudgeDrop | null) {
  const q = new URLSearchParams(window.location.search);
  q.delete("d");
  q.delete("k");
  q.delete("fresh");
  const qs = q.toString();
  return `/judge${qs ? `?${qs}` : ""}${res ? `#d=${encodeURIComponent(res.slug)}&k=${encodeURIComponent(res.sellerKey)}` : ""}`;
}

function initialDrop(): JudgeDrop | null {
  const q = new URLSearchParams(window.location.search);
  if (q.get("fresh") === "1") {
    store.del(JUDGE_KEY);
    window.history.replaceState({}, "", judgeUrl(null));
    return null;
  }
  const h = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const slug = h.get("d") ?? q.get("d");
  const key = h.get("k") ?? q.get("k");
  if (slug && key) {
    const r = { slug, sellerKey: key };
    store.set(JUDGE_KEY, r);
    if (q.has("k")) window.history.replaceState({}, "", judgeUrl(r));
    return r;
  }
  return store.get<JudgeDrop>(JUDGE_KEY);
}

/** ?code= unlocks the sandbox buyers; it is remembered in this browser and dropped from the visible URL. */
function initialCode(): string {
  const q = new URLSearchParams(window.location.search);
  const c = q.get("code");
  if (c) {
    store.set(CODE_KEY, c);
    q.delete("code");
    const qs = q.toString();
    window.history.replaceState({}, "", `/judge${qs ? `?${qs}` : ""}${window.location.hash}`);
    return c;
  }
  return store.get<string>(CODE_KEY) ?? "";
}

function useNow(ms = 1000) {
  const [n, setN] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setN(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}

const flag = (k: string) => {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
};

export function JudgePage() {
  const [res, setRes] = useState<JudgeDrop | null>(initialDrop);
  const [code] = useState(initialCode);
  const [drop, setDrop] = useState<PublicDrop | null>(null);
  const [notice, setNotice] = useState<"gone" | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const now = useNow();

  // poll the drop every 3 s; a restored drop may be gone (the demo restarted): say so instead of handing out dead links
  useEffect(() => {
    if (!res) {
      setDrop(null);
      return;
    }
    let alive = true;
    const load = () =>
      api<PublicDrop>(`/api/drops/${res.slug}`)
        .then((d) => alive && setDrop(d))
        .catch((e) => {
          if (!alive || !(e instanceof ApiError && e.status === 404)) return;
          store.del(JUDGE_KEY);
          window.history.replaceState({}, "", judgeUrl(null));
          setRes(null);
          setNotice("gone");
        });
    void load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [res]);

  const start = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api<JudgeDrop>("/api/judge-drop", { method: "POST", headers: code ? { "x-judge-code": code } : undefined });
      store.set(JUDGE_KEY, r);
      window.history.replaceState({}, "", judgeUrl(r));
      setNotice(null);
      setRes(r);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    store.del(JUDGE_KEY);
    window.history.replaceState({}, "", judgeUrl(null));
    setNotice(null);
    setDrop(null);
    setRes(null);
  };

  const finished = drop && (drop.status === "drawn" || drop.status === "settled");
  return (
    <div className="judge-page">
      <section className="judge-intro">
        <h1>Try to scalp us</h1>
        <p className="context">Judge mode · about 2 minutes</p>
        <p className="lede">
          Your own 30-minute drop with 2 units, its fan page and its seller console. Every entry is a real PayPal sandbox hold, one per PayPal account. The
          checklist ticks itself as things happen.
        </p>
      </section>
      {notice === "gone" && (
        <p className="alert" role="status" data-testid="judge-gone">
          Your previous drop is gone (the demo restarted). Start a new one below.
        </p>
      )}
      {finished && res && (
        <p className="alert alert-ok" role="status">
          Your drop is {drop!.status === "settled" ? "settled" : "drawn"} → <Link href={`/verify/${res.slug}`}>Verify the draw</Link> ·{" "}
          <button className="linklike" onClick={reset}>
            Start another
          </button>
        </p>
      )}
      <div className="judge-grid">
        <section className="card judge-main" aria-labelledby="check-title">
          <div className="card-head">
            <h2 id="check-title">Your checklist</h2>
            {drop && drop.status === "open" && (
              <span className="countdown-chip" aria-live="off">
                <ClockIcon size={15} /> Draw at {clock(drop.closesAt)} · {drop.closesAt > now ? `closes in ${timeLeft(drop.closesAt - now)}` : "closing now"}
              </span>
            )}
          </div>
          <Checklist res={res} drop={drop} busy={busy} onStart={start} />
          {err && (
            <p className="alert alert-bad" role="status">
              {err}
            </p>
          )}
          <div className="judge-foot">
            <p className="muted small">
              Holds are {usd(4800)} in the PayPal sandbox. Nothing real is charged, and everyone not selected gets their hold voided.
            </p>
            {res && (
              <button className="btn btn-sm" onClick={reset} data-testid="judge-new">
                New drop
              </button>
            )}
          </div>
        </section>
        <aside className="judge-aside">
          <BuyersCard code={code} />
          <AgentCard slug={res?.slug ?? null} />
          <ProofLink />
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the checklist

interface Item {
  key: string;
  title: string;
  done: boolean;
  live?: boolean;
  result: ReactNode;
  action?: ReactNode;
}

function Checklist({ res, drop, busy, onStart }: { res: JudgeDrop | null; drop: PublicDrop | null; busy: boolean; onStart: () => void }) {
  const s = drop?.stats;
  const slug = res?.slug ?? "";
  const console = res ? sellerHref(res.slug, res.sellerKey) : "";
  const pending = drop?.pendingReviews ?? 0;
  const closed = !!drop && drop.status !== "open";
  const reviewed = !!res && flag(`paylet.reviewed.${slug}`);
  const verified = !!res && flag(`paylet.verified.${slug}`);
  const items: Item[] = [
    {
      key: "created",
      title: "Drop created",
      done: !!drop,
      result: drop ? (
        <>
          {drop.title} · {drop.units} units · draw at {clock(drop.closesAt)}
        </>
      ) : res ? (
        "Loading your drop…"
      ) : (
        "A 30-minute drop with its own fan page and seller console."
      ),
      action: !res ? (
        <button className="btn btn-primary" disabled={busy} onClick={onStart} data-testid="judge-start">
          {busy ? "Creating…" : "Start my judge drop"}
        </button>
      ) : (
        <Link className="btn btn-sm" href={`/d/${slug}`}>
          Fan page
        </Link>
      ),
    },
    {
      key: "enter",
      title: "Enter with PayPal",
      done: (s?.holds ?? 0) >= 1,
      result:
        s && s.holds >= 1 ? (
          <>
            {nf(s.holds)} PayPal hold{s.holds === 1 ? "" : "s"} placed · nothing charged
          </>
        ) : (
          "Log in with sandbox buyer A and approve a $48.00 hold. You're charged only if you win."
        ),
      action: res && (
        <Link className="btn btn-sm" href={`/d/${slug}`}>
          Fan page
        </Link>
      ),
    },
    {
      key: "again",
      title: "Try again with the same account",
      done: (s?.duplicatesBlocked ?? 0) >= 1,
      result:
        s && s.duplicatesBlocked >= 1 ? (
          <>
            {nf(s.duplicatesBlocked)} same-account duplicate{s.duplicatesBlocked === 1 ? "" : "s"} → no hold
          </>
        ) : (
          "In another tab, or through an AI agent. Paylet reads the payer from PayPal's own order record."
        ),
      action: res && (
        <span className="row gap-sm wrap">
          <Link className="btn btn-sm" href={`/d/${slug}`}>
            Fan page
          </Link>
          <Link className="btn btn-sm" href={`/agent?drop=${slug}`}>
            <BotIcon size={14} /> Via AI agent
          </Link>
        </span>
      ),
    },
    {
      key: "agents",
      title: "Unleash scalper agents",
      done: (s?.agents ?? 0) >= 1,
      result: s && s.agents >= 1 ? <>{nf(s.agents)} agent requests · 0 holds without a person</> : "Console step 1: 12 bots enter over MCP. Each gets a PayPal link, none gets a hold.",
      action: res && (
        <Link className="btn btn-sm" href={console}>
          Seller console
        </Link>
      ),
    },
    {
      key: "review",
      title: "AI review + decide",
      done: (s?.merged ?? 0) >= 1 || (pending === 0 && (reviewed || closed)),
      live: pending > 0,
      result:
        pending > 0 ? (
          <>
            {pending} AI suggestion{pending === 1 ? "" : "s"} waiting for your decision
          </>
        ) : s && s.merged >= 1 ? (
          <>{nf(s.merged)} accounts merged into shared tickets</>
        ) : reviewed ? (
          "All suggestions decided"
        ) : (
          "Add the simulated crowd, run the AI review, then confirm or dismiss each group."
        ),
      action: res && (
        <Link className="btn btn-sm" href={console}>
          Seller console
        </Link>
      ),
    },
    {
      key: "draw",
      title: "Close & draw",
      done: drop?.status === "settled",
      live: drop?.status === "frozen" || drop?.status === "drawn",
      result:
        drop?.status === "settled"
          ? "Settled: winners captured, every other hold voided"
          : drop?.status === "frozen"
            ? "List frozen · waiting for public randomness (drand)"
            : drop?.status === "drawn"
              ? "Drawn · settling with PayPal…"
              : "Console step 5. The list freezes, then a public drand round picks the winners.",
      action: res && (
        <Link className="btn btn-sm" href={console}>
          Seller console
        </Link>
      ),
    },
    {
      key: "verify",
      title: "Verify + Ask PayPal",
      done: verified,
      result: verified ? "You re-checked this drop yourself" : "Re-run the draw in your browser, then ask PayPal about every hold.",
      action: res && (
        <Link className="btn btn-sm" href={`/verify/${slug}`}>
          Verify page
        </Link>
      ),
    },
  ];
  // once entries close, the entry steps that didn't happen can't happen any more: say so instead of pointing at them
  const SKIPPABLE = new Set(["enter", "again", "agents", "review"]);
  const skipped = (it: Item) => closed && !it.done && SKIPPABLE.has(it.key);
  const current = items.findIndex((i) => !i.done && !skipped(i));
  return (
    <ol className="check" data-testid="judge-checklist">
      {items.map((it, i) => (
        <li
          key={it.key}
          className={`${it.done ? "done" : skipped(it) ? "skipped" : i === current ? "current" : ""} ${it.live && !it.done ? "is-live" : ""}`}
          data-testid={`check-${it.key}`}
          data-done={it.done ? "1" : "0"}
          aria-current={i === current ? "step" : undefined}
        >
          <span className="step-n" aria-hidden="true">
            {it.done ? <CheckIcon size={14} /> : i + 1}
          </span>
          <div className="check-text">
            <b>{it.title}</b>
            <span className="sr-only"> ({it.done ? "done" : skipped(it) ? "skipped" : i === current ? "next" : "not yet"})</span>
            <small>{skipped(it) ? "Not done in this drop: entries are closed. Start another drop to try it." : it.result}</small>
          </div>
          <div className="check-action">{skipped(it) ? null : it.action}</div>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- sandbox buyers, only with ?code= (never in the bundle or the repo)

function BuyersCard({ code }: { code: string }) {
  const [state, setState] = useState<{ buyers: JudgeBuyer[] | null; error: string }>({ buyers: null, error: "" });
  useEffect(() => {
    if (!code) return;
    let alive = true;
    api<{ buyers: JudgeBuyer[] }>(`/api/judge-buyers?code=${encodeURIComponent(code)}`)
      .then((r) => alive && setState({ buyers: r.buyers, error: "" }))
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
          store.del(CODE_KEY);
          setState({ buyers: null, error: "That code didn't work. Open the exact /judge?code=… link from the Devpost testing instructions." });
        } else setState({ buyers: null, error: friendlyError(e) });
      });
    return () => {
      alive = false;
    };
  }, [code]);
  return (
    <section className="card buyers" aria-labelledby="buyers-title" data-testid="buyers">
      <h3 id="buyers-title">
        <KeyIcon size={17} /> Sandbox buyer accounts
      </h3>
      <p className="muted small">Fictitious PayPal sandbox accounts. They only work in the sandbox popup.</p>
      {!code ? (
        <p className="small" data-testid="buyers-locked">
          Credentials are in the Devpost testing instructions. Open the <code className="nowrap">/judge?code=…</code> link from there.
        </p>
      ) : state.error ? (
        <p className="alert small">{state.error}</p>
      ) : !state.buyers ? (
        <div className="skeleton">Loading…</div>
      ) : (
        <>
          <ul className="buyer-list">
            {state.buyers.map((b) => (
              <Buyer key={b.email} b={b} />
            ))}
          </ul>
          <p className="small hint">Enter with A, then with B (same household: the AI groups them). Then try A again: no second hold.</p>
        </>
      )}
    </section>
  );
}

function Buyer({ b }: { b: JudgeBuyer }) {
  const [show, setShow] = useState(false);
  return (
    <li className="buyer" data-testid="buyer">
      <b>{b.label}</b>
      <div className="cred">
        <span className="cred-k">Email</span>
        <code>{b.email}</code>
        <CopyButton value={b.email} label={`${b.label} email`} />
      </div>
      <div className="cred">
        <span className="cred-k">Password</span>
        <code aria-label={show ? undefined : "hidden password"}>{show ? b.password : "••••••••••"}</code>
        <span className="row gap-sm">
          <button type="button" className="btn btn-sm btn-copy" aria-pressed={show} onClick={() => setShow((x) => !x)}>
            <EyeIcon size={14} /> {show ? "Hide" : "Show"}
          </button>
          <CopyButton value={b.password} label={`${b.label} password`} />
        </span>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- bring your own agent (MCP)

function Snippet({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <div className="snippet">
      <div className="snippet-head">
        <span>{label}</span>
        <CopyButton value={value} label={label.toLowerCase()} />
      </div>
      <pre>
        <code>{value}</code>
      </pre>
      {hint && <small className="muted">{hint}</small>}
    </div>
  );
}

function AgentCard({ slug }: { slug: string | null }) {
  const [mcp, setMcp] = useState(`${window.location.origin}/mcp`);
  useEffect(() => {
    void api<{ mcpUrl?: string }>("/api/config")
      .then((c) => c.mcpUrl && setMcp(c.mcpUrl))
      .catch(() => undefined);
  }, []);
  const base = mcp.replace(/\/mcp$/, "");
  const mcpJson = JSON.stringify({ servers: { paylet: { type: "http", url: mcp } } }, null, 2);
  return (
    <section className="card byo" aria-labelledby="byo-title" data-testid="byo-agent">
      <h3 id="byo-title">
        <TerminalIcon size={17} /> Bring your own agent
      </h3>
      <p className="small">
        Paylet is an MCP server (Streamable HTTP). Any agent can request an entry. Only a person can approve the hold in PayPal.
      </p>
      <Snippet label="Claude Code" value={`claude mcp add --transport http paylet ${mcp}`} />
      <Snippet label="VS Code · .vscode/mcp.json" value={mcpJson} />
      <Snippet label="MCP Inspector" value="npx @modelcontextprotocol/inspector" hint={<>Transport: Streamable HTTP · URL: {mcp}</>} />
      {slug && <Snippet label="Then tell your agent" value={`Enter me in ${base}/d/${slug}`} />}
    </section>
  );
}

function ProofLink() {
  const [proof, setProof] = useState<ProofInfo | null>(null);
  useEffect(() => {
    void apiOptional<ProofInfo>("/api/proof")
      .then(setProof)
      .catch(() => undefined);
  }, []);
  if (!proof?.slug) return null;
  return (
    <section className="card proof-mini" data-testid="judge-proof">
      <h3>
        <ShieldIcon size={17} /> A finished real run
      </h3>
      {proof.summary && <p className="small">{proof.summary}</p>}
      <Link href={`/verify/${proof.slug}`} className="btn btn-sm">
        See the proof drop →
      </Link>
    </section>
  );
}
