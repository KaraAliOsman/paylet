import { useEffect, useRef, useState, type ReactNode } from "react";
import { Art } from "./components";
import { ArrowIcon, BotIcon, CheckIcon, CrossIcon, DiceIcon, LockIcon, RefundIcon } from "./icons";
import { Link } from "./router";

/**
 * The home-page hero visual: what happens to one PayPal hold, in four outcomes. The amounts are the proof drop's
 * real sandbox numbers (docs/proof-run.json): a $48.00 hold ($38 price + $10 max shipping), $44.50 captured
 * ($38 + $6.50 real shipping), $3.50 released.
 */
const HOLD = 4800;
const CAPTURED = 4450;
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

type Tone = "ok" | "held" | "no" | "ai" | "plain";
type Bar = "captured" | "voided" | "none";
interface Scenario {
  id: string;
  tab: string;
  bar: Bar;
  barNote: string;
  charged: number;
  steps: { tone: Tone; icon: ReactNode; text: ReactNode; tag?: string }[];
}

const SCENARIOS: Scenario[] = [
  {
    id: "win",
    tab: "Winner",
    bar: "captured",
    barNote: "",
    charged: CAPTURED,
    steps: [
      { tone: "ai", icon: <BotIcon size={13} />, text: <><b>Your AI agent</b> requested the entry</>, tag: "MCP enter_drop" },
      { tone: "held", icon: <LockIcon size={13} />, text: <><b>You</b> approved a {money(HOLD)} hold in PayPal</>, tag: "AUTHORIZE" },
      { tone: "ok", icon: <DiceIcon size={13} />, text: <>Public draw: <b>selected</b></>, tag: "drand" },
      { tone: "ok", icon: <CheckIcon size={13} />, text: <>Charged <b>{money(CAPTURED)}</b>: price + real shipping</>, tag: "capture" },
    ],
  },
  {
    id: "lose",
    tab: "Not selected",
    bar: "voided",
    barNote: "",
    charged: 0,
    steps: [
      { tone: "held", icon: <LockIcon size={13} />, text: <><b>You</b> approved a {money(HOLD)} hold in PayPal</>, tag: "AUTHORIZE" },
      { tone: "plain", icon: <DiceIcon size={13} />, text: <>Public draw: not selected this time</>, tag: "drand" },
      { tone: "ok", icon: <RefundIcon size={13} />, text: <>Hold voided. <b>{money(0)}</b> charged</>, tag: "void" },
    ],
  },
  {
    id: "bot",
    tab: "Agent alone",
    bar: "none",
    barNote: "No hold: an agent can't approve a payment",
    charged: 0,
    steps: [
      { tone: "ai", icon: <BotIcon size={13} />, text: <>A scalper's agent requested <b>12 entries</b></>, tag: "MCP enter_drop" },
      { tone: "no", icon: <CrossIcon size={13} />, text: <>12 PayPal links issued. Nobody approved them</> },
      { tone: "no", icon: <CrossIcon size={13} />, text: <><b>0 holds</b>, so 0 tickets in the draw</> },
    ],
  },
  {
    id: "dup",
    tab: "Same account",
    bar: "none",
    barNote: "No hold: one entry per PayPal account",
    charged: 0,
    steps: [
      { tone: "held", icon: <LockIcon size={13} />, text: <>Account A already holds an entry</>, tag: "AUTHORIZE" },
      { tone: "plain", icon: <BotIcon size={13} />, text: <>A tries again with a new email and a new agent</> },
      { tone: "no", icon: <CrossIcon size={13} />, text: <>PayPal says it's the same payer: <b>no hold</b></>, tag: "payer_id" },
    ],
  },
];

const CYCLE_MS = 5600;
const SETTLE_MS = 1500;

export function HoldDemo({ verifyHref }: { verifyHref: string | null }) {
  const [i, setI] = useState(0);
  const [settled, setSettled] = useState(false);
  const [auto, setAuto] = useState(true);
  const [paused, setPaused] = useState(false);
  const reduced = useRef(typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const s = SCENARIOS[i];

  // each outcome starts as a pending hold and settles a moment later
  useEffect(() => {
    if (s.bar === "none" || reduced.current) {
      setSettled(true);
      return;
    }
    setSettled(false);
    const t = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(t);
  }, [i, s.bar]);

  useEffect(() => {
    if (!auto || paused || reduced.current) return;
    const t = setTimeout(() => setI((n) => (n + 1) % SCENARIOS.length), CYCLE_MS);
    return () => clearTimeout(t);
  }, [i, auto, paused]);

  const pick = (n: number) => {
    setAuto(false);
    setI(n);
  };

  const state: "held" | Bar = s.bar === "none" ? "none" : settled ? s.bar : "held";
  const capW = state === "captured" ? (CAPTURED / HOLD) * 100 : 0;
  const relW = state === "captured" ? 100 - capW : 0;
  const amount = state === "held" ? HOLD : s.charged;

  return (
    <div
      className="hd"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      style={{ ["--hd-ms" as string]: `${CYCLE_MS}ms` }}
    >
      <div className="hd-tabs" role="tablist" aria-label="What happens to a PayPal hold">
        <span className="hd-tab-ind" aria-hidden="true" style={{ width: "calc((100% - 12px) / 4)", transform: `translateX(calc(${i} * (100% + 2px)))` }} />
        {SCENARIOS.map((x, n) => (
          <button key={x.id} type="button" role="tab" aria-selected={n === i} className="hd-tab" onClick={() => pick(n)}>
            {x.tab}
            {n === i && auto && !reduced.current && (
              <span className="hd-tab-prog" aria-hidden="true">
                <i key={`${i}-${paused}`} className={paused ? "" : "run"} />
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="hd-body" role="tabpanel" aria-live="polite">
        <div className="hd-item">
          <Art art="ember" size={56} />
          <div>
            <b>Ember Glaze Mug</b>
            <small>1 unit · $38.00 + shipping</small>
          </div>
          <div className="hd-amount">
            <b>{money(amount)}</b>
            <small className="muted">{state === "held" ? "on hold" : "charged"}</small>
          </div>
        </div>

        <div className="holdbar" data-s={state}>
          <div className="holdbar-track">
            <span className="holdbar-held" />
            <span className="holdbar-cap" style={{ width: `${capW}%` }} />
            <span className="holdbar-rel" style={{ width: `${relW}%` }} />
            <span className="holdbar-label">
              {state === "held" && <>PayPal hold · {money(HOLD)}</>}
              {state === "captured" && <>Captured {money(CAPTURED)}</>}
              {state === "voided" && (
                <>
                  <s>Hold {money(HOLD)}</s> voided
                </>
              )}
              {state === "none" && s.barNote}
            </span>
          </div>
          <div className="holdbar-legend">
            {state === "held" && <span>Authorized, not charged. Nothing moves until the draw.</span>}
            {state === "captured" && (
              <>
                <span className="k">
                  Charged <b>{money(CAPTURED)}</b>
                </span>
                <span className="k" style={{ ["--k" as string]: "var(--faint)" }}>
                  Released <b>{money(HOLD - CAPTURED)}</b>
                </span>
              </>
            )}
            {state === "voided" && <span>The whole hold is released. Never charged.</span>}
            {state === "none" && <span>Nothing reaches the draw.</span>}
          </div>
        </div>

        <ol className="hd-steps" key={s.id}>
          {s.steps.map((st, n) => (
            <li key={n} className={`hd-step ${st.tone}`} style={{ ["--i" as string]: n }}>
              <span className="dot" aria-hidden="true">
                {st.icon}
              </span>
              <span>{st.text}</span>
              {st.tag ? <span className={`tag ${st.tag === "drand" || st.tag.startsWith("MCP") ? "tag-local" : "tag-real"}`}>{st.tag}</span> : <span />}
            </li>
          ))}
        </ol>
      </div>

      <div className="hd-foot">
        <span>Real amounts from the proof drop, PayPal sandbox</span>
        {verifyHref && (
          <Link href={verifyHref}>
            Check them with PayPal <ArrowIcon size={13} />
          </Link>
        )}
      </div>
    </div>
  );
}
