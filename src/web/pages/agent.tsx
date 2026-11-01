import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, friendlyError, timeLeft, usd, type AgentChatResponse, type AgentHandoff, type AgentTraceItem, type Participant } from "../api";
import { Art, StatusPill } from "../components";
import { HoldTimeline, timelineInput } from "../hold-timeline";
import { LockIcon } from "../icons";
import { Link } from "../router";
import { approvalExpiresAt } from "../timeline";

// ---------------------------------------------------------------- Fan's agent (MCP client + MiMo), as a chat

interface Turn {
  role: "user" | "assistant";
  content: string;
  trace?: AgentTraceItem[];
  handoff?: AgentHandoff | null;
  error?: boolean;
}

const GREETING: Turn = {
  role: "assistant",
  content: "Hi, I'm Wren, your shopping assistant. I can find limited drops on Paylet and request an entry for you. I can't pay: you approve any hold yourself in PayPal.",
};
const STORE = "paylet.wren.v1";

/** Accepts both the v2 contract ({trace:{tool,summary,raw}[], handoff}) and the older shape ({trace:{tool,args,result}[], approveUrl, entryRef}). */
export function normalizeChat(r: Record<string, any>): AgentChatResponse {
  const legacy = Array.isArray(r.trace) && r.trace.some((t: any) => t && !("summary" in t));
  const trace: AgentTraceItem[] = (r.trace ?? []).map((t: any) => (legacy ? { tool: t.tool, summary: summarize(t.tool, t.args, t.result), raw: { args: t.args, result: t.result } } : t));
  let handoff: AgentHandoff | null = r.handoff ?? null;
  if (!handoff && typeof r.approveUrl === "string") {
    const entered = (r.trace ?? []).find((t: any) => t?.result?.approve_url)?.result ?? {};
    handoff = {
      entryRef: r.entryRef ?? entered.entry_ref ?? "",
      publicId: entered.public_id ?? "",
      title: "",
      holdCents: typeof entered.hold_usd === "number" ? Math.round(entered.hold_usd * 100) : 0,
      approveUrl: r.approveUrl,
      expiresAt: 0,
    };
  }
  return { reply: String(r.reply ?? ""), trace, handoff, error: r.error === true ? true : undefined };
}

function summarize(tool: string, args: any, result: any): string {
  if (result && typeof result === "object") {
    if (tool === "list_drops" && Array.isArray(result.drops)) return `list_drops → ${result.drops.length} drop${result.drops.length === 1 ? "" : "s"}`;
    if (tool === "enter_drop") return `enter_drop(${args?.drop ?? "?"}) → ${result.status ?? (result.approve_url ? "awaiting_person" : "error")}`;
    if (result.status) return `${tool} → ${result.status}`;
  }
  return typeof result === "string" && result.length < 60 ? `${tool} → ${result}` : tool;
}

/** Strip markdown emphasis and, when the card carries the link, any raw URL in the reply. */
function clean(text: string, hasCard: boolean): string {
  let t = text.replace(/\*\*/g, "");
  if (hasCard) t = t.replace(/https?:\/\/\S+/g, "(the button below)");
  return t;
}

function loadTurns(drop: string | null): Turn[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE) ?? "null") as { drop: string | null; turns: Turn[] } | null;
    if (saved && Array.isArray(saved.turns) && saved.turns.length && (!drop || saved.drop === drop)) return saved.turns;
  } catch {
    /* ignore */
  }
  return [GREETING];
}

export function AgentPage() {
  const drop = new URLSearchParams(window.location.search).get("drop");
  const [turns, setTurns] = useState<Turn[]>(() => loadTurns(drop));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<"" | "chat" | "status">("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // braces matter: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup
    end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns.length, busy]);
  useEffect(() => {
    sessionStorage.setItem(STORE, JSON.stringify({ drop, turns }));
  }, [turns, drop]);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy) return;
    const next = [...turns, { role: "user" as const, content }];
    setTurns(next);
    setInput("");
    setBusy("chat");
    try {
      const raw = await api<Record<string, unknown>>("/api/agent/chat", {
        method: "POST",
        json: { messages: next.slice(1).map(({ role, content }) => ({ role, content })) },
      });
      const r = normalizeChat(raw);
      setTurns([...next, { role: "assistant", content: r.reply || "I couldn't reach Paylet just now.", trace: r.trace, handoff: r.handoff, error: r.error }]);
    } catch (e) {
      setTurns([...next, { role: "assistant", content: `Sorry, I couldn't reach Paylet: ${friendlyError(e)}`, error: true }]);
    } finally {
      setBusy("");
    }
  };

  const askHowItWent = useCallback(
    async (entryRef: string) => {
      if (busy) return;
      const q: Turn = { role: "user", content: "How did it go?" };
      setTurns((t) => [...t, q]);
      setBusy("status");
      let turn: Turn;
      try {
        const r = await api<{ reply: string; status: string }>("/api/agent/how-it-went", { method: "POST", json: { entryRef } });
        turn = { role: "assistant", content: r.reply, trace: [{ tool: "entry_status", summary: `entry_status → ${r.status}`, raw: r }] };
      } catch (e) {
        if (e instanceof ApiError && e.code === "not_available") {
          // older server: answer from the public entry record (same facts entry_status returns)
          const p = await api<Participant>(`/api/entries/${entryRef}`).catch(() => null);
          turn = p
            ? { role: "assistant", content: howItWent(p), trace: [{ tool: "entry_status", summary: `entry_status → ${p.status}`, raw: { status: p.status } }] }
            : { role: "assistant", content: "I couldn't find that entry anymore. The demo may have restarted.", error: true };
        } else turn = { role: "assistant", content: `Sorry, I couldn't check: ${friendlyError(e)}`, error: true };
      }
      setTurns((t) => [...t, turn]);
      setBusy("");
    },
    [busy],
  );

  const chips = [
    ...(drop ? [`Get me into this drop: ${window.location.origin}/d/${drop}`] : []),
    "What drops are open?",
    "Can you pay for me?",
  ];
  const started = turns.some((t) => t.role === "user");

  return (
    <div className="agent">
      <section className="card agent-chat">
        <div className="card-head">
          <div>
            <h3>Wren · your personal agent</h3>
            <span className="muted small">MiMo V2.6 Pro → Paylet over MCP (list_drops · enter_drop · entry_status)</span>
          </div>
          {started && (
            <button className="btn btn-sm" onClick={() => setTurns([GREETING])} disabled={!!busy}>
              New chat
            </button>
          )}
        </div>
        <div className="msgs" role="log" aria-live="polite" aria-label="Conversation with Wren">
          {turns.map((t, i) => (
            <div key={i} className={`turn turn-${t.role}`}>
              <div className={`msg msg-${t.role}`}>
                <div className={`bubble ${t.error ? "bubble-error" : ""}`}>
                  {clean(t.content, !!t.handoff)
                    .split("\n")
                    .filter((l) => l.trim())
                    .map((l, j) => (
                      <p key={j}>{l}</p>
                    ))}
                </div>
              </div>
              {t.trace && t.trace.length > 0 && <TraceChips trace={t.trace} />}
              {t.handoff && <HandoffCard h={t.handoff} onAsk={askHowItWent} busy={!!busy} />}
            </div>
          ))}
          {busy && (
            <div className="msg msg-assistant">
              <div className="bubble typing">{busy === "status" ? "Wren is checking your entry…" : "Wren is calling Paylet over MCP…"}</div>
            </div>
          )}
          <div ref={end} />
        </div>
        {!started && (
          <div className="chips" aria-label="Suggestions">
            {chips.map((c) => (
              <button key={c} className="chip" onClick={() => void send(c)} disabled={!!busy}>
                {c}
              </button>
            ))}
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <input aria-label="Message Wren" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask Wren, or paste a drop link…" />
          <button className="btn btn-primary" disabled={!!busy || !input.trim()}>
            Send
          </button>
        </form>
      </section>
    </div>
  );
}

function TraceChips({ trace }: { trace: AgentTraceItem[] }) {
  return (
    <div className="trace-row">
      <span className="trace-label">MCP</span>
      <ul className="trace-chips" aria-label="Tools Wren called">
        {trace.map((x, k) => {
          const m = x.summary.startsWith(x.tool) ? /^([\w.-]+(?:\([^)]*\))?)\s*(?:→|->)?\s*(.*)$/.exec(x.summary) : null;
          const head = m ? m[1] : x.tool;
          const tail = m ? m[2] : x.summary;
          return (
            <li key={k} className="trace-chip">
              <code>{head}</code>
              {tail && <span>→ {tail}</span>}
            </li>
          );
        })}
      </ul>
      <details className="trace-raw">
        <summary>raw</summary>
        <pre>{JSON.stringify(trace.map((x) => ({ tool: x.tool, raw: x.raw })), null, 2).slice(0, 4000)}</pre>
      </details>
    </div>
  );
}

const POST_DRAW = new Set(["won", "waitlist", "lost", "captured", "voided", "capture_failed", "refunded", "duplicate", "expired", "merged", "error"]);
const TERMINAL = new Set(["captured", "voided", "capture_failed", "refunded", "duplicate", "expired", "error"]);

/** The agent's hand-off to the person: Wren stops at PayPal, the person approves. Live: it follows the entry until it settles. */
export function HandoffCard({ h, onAsk, busy }: { h: AgentHandoff; onAsk: (entryRef: string) => void; busy: boolean }) {
  const [p, setP] = useState<Participant | null>(null);
  const [gone, setGone] = useState(false);
  const [now, setNow] = useState(Date.now());
  const done = p ? TERMINAL.has(p.status) && p.drop.status === "settled" : false;
  useEffect(() => {
    if (!h.entryRef || done) return;
    let alive = true;
    const load = () =>
      api<Participant>(`/api/entries/${h.entryRef}`)
        .then((x) => alive && setP(x))
        .catch((e) => alive && e instanceof ApiError && e.status === 404 && setGone(true));
    void load();
    const t = setInterval(() => {
      setNow(Date.now());
      void load();
    }, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [h.entryRef, done]);

  const status = p?.status ?? "awaiting_person";
  const hold = h.holdCents || p?.holdCents || null;
  const title = h.title || p?.drop.title || "";
  const expiresAt = h.expiresAt || (p ? approvalExpiresAt(p.timeline?.requestedAt, p.drop.closesAt) : 0);
  const awaiting = status === "awaiting_person";
  const expired = awaiting && expiresAt > 0 && expiresAt <= now;
  const finished = !!p && (p.drop.status === "drawn" || p.drop.status === "settled" || POST_DRAW.has(status));

  return (
    <section className="handoff" aria-label="Approve in PayPal">
      <header className="handoff-head">
        <span className="handoff-lock">
          <LockIcon size={18} />
        </span>
        <div>
          <b>Your agent stopped here.</b>
          <span>Wren can't approve or pay. Only you can.</span>
        </div>
      </header>
      <div className="handoff-drop">
        {p && <Art art={p.drop.art} size={44} />}
        <div>
          <b>{title || "Your entry"}</b>
          <span>
            {p?.drop.maker ? `${p.drop.maker} · ` : ""}entry <code>{h.publicId || p?.publicId || "…"}</code>
          </span>
        </div>
      </div>
      {gone ? (
        <p className="small muted">This entry isn't on the server anymore (the demo restarted). Nothing was charged.</p>
      ) : awaiting && !expired ? (
        <>
          <a className="btn btn-paypal btn-lg" href={h.approveUrl} target="_blank" rel="noopener">
            Approve {hold ? usd(hold) : "the"} hold in PayPal
          </a>
          <p className="small muted handoff-fine">
            Charged only if you win{expiresAt > now ? ` · link expires in ${timeLeft(expiresAt - now)}` : ""}
          </p>
        </>
      ) : expired ? (
        <p className="small">This approval link expired. No hold was placed, nothing was charged.</p>
      ) : (
        <StatusPill status={status} />
      )}
      {!gone && (
        <HoldTimeline
          compact
          max={awaiting || status === "authorizing" ? 3 : undefined}
          input={p ? timelineInput(p, hold) : { status, holdCents: hold, capturedCents: null, closesAt: Date.now(), dropStatus: "open" }}
        />
      )}
      <div className="row gap wrap handoff-foot">
        {h.entryRef && <Link href={`/me/${h.entryRef}`}>Track this entry →</Link>}
        {finished && !gone && (
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => onAsk(h.entryRef)}>
            Ask Wren how it went
          </button>
        )}
      </div>
    </section>
  );
}

/** Deterministic answer from the entry record (fallback for servers without /api/agent/how-it-went). */
function howItWent(p: Participant): string {
  const hold = usd(p.holdCents);
  switch (p.status) {
    case "captured": {
      const released = p.holdCents != null && p.capturedCents != null ? p.holdCents - p.capturedCents : 0;
      return `You got one. PayPal captured ${usd(p.capturedCents)}${released > 0 ? ` and released ${usd(released)} of your hold` : ""}.`;
    }
    case "voided":
    case "lost":
      return `Not selected. PayPal voided your ${hold} hold. Charged: $0.`;
    case "capture_failed":
      return "You were selected, but the payment didn't go through, so the unit passed to the next fan on the waitlist. Your hold was released. Charged: $0.";
    case "refunded":
      return `The seller refunded ${usd(p.refundedCents ?? p.capturedCents)}. You owe nothing.`;
    case "won":
      return "You were selected. PayPal is capturing the payment now.";
    case "waitlist":
      return `You're on the waitlist. Your ${hold} hold stays until the winners pay; if nobody's payment fails, it's voided and you pay $0.`;
    case "held":
      return `Your ${hold} hold is in place. The draw hasn't happened yet.`;
    case "duplicate":
      return "No hold was placed: that PayPal account already had an entry in this drop. Charged: $0.";
    case "merged":
      return "Your entry was merged with your household's, so your hold was released. Charged: $0.";
    case "expired":
      return "The approval link expired before it was approved, so no hold was placed. Charged: $0.";
    case "awaiting_person":
      return "I'm still waiting for you to approve the hold in PayPal.";
    default:
      return `Your entry is ${p.status.replace(/_/g, " ")}.`;
  }
}
