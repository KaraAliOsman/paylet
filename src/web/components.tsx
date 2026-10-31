import { useEffect, useRef, useState, type ReactNode } from "react";
import { loadCoreSdkScript } from "@paypal/paypal-js/sdk-v6";
import { api, type EventRow, type Participant } from "./api";
import { Link } from "./router";

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "paypal-button": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { type?: string; hidden?: boolean };
    }
  }
}

// ---------------------------------------------------------------- layout

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="brand">
          <span className="brand-mark">P</span>
          <span>Paylet</span>
        </Link>
        <nav>
          <Link href="/agent">Fan's agent</Link>
          <Link href="/evals">Evals</Link>
          <Link href="/judge" className="nav-cta">
            Try to scalp us
          </Link>
        </nav>
      </header>
      <main>{children}</main>
      <footer className="foot">
        <span>
          PayPal <b>sandbox</b> only · no real money moves · AI: MiMo V2.6 Pro
        </span>
        <span>
          <Link href="/how">How it works</Link> · <a href="https://github.com/KaraAliOsman/paylet">Source (MIT)</a>
        </span>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------- generated product art (no stock images, no third-party marks)

const ARTS: Record<string, [string, string, string]> = {
  tidepool: ["#0f4c5c", "#5fb3b3", "#f6c86a"],
  ember: ["#5b1e14", "#d9653b", "#f3d3a4"],
  default: ["#2d2350", "#8f7cf0", "#f6c86a"],
};

export function Art({ art, size = 220 }: { art: string; size?: number }) {
  const [a, b, c] = ARTS[art] ?? ARTS.default;
  const keys = art === "ember" ? 1 : 6;
  return (
    <svg className="art" width={size} height={size} viewBox="0 0 200 200" role="img" aria-label={`${art} artwork`}>
      <defs>
        <radialGradient id={`g-${art}`} cx="30%" cy="25%" r="90%">
          <stop offset="0%" stopColor={b} />
          <stop offset="100%" stopColor={a} />
        </radialGradient>
      </defs>
      <rect width="200" height="200" rx="28" fill={`url(#g-${art})`} />
      {art === "ember" ? (
        <g>
          <rect x="58" y="62" width="74" height="86" rx="14" fill={c} opacity="0.95" />
          <path d="M132 82c22 0 22 40 0 40" stroke={c} strokeWidth="10" fill="none" />
          <path d="M70 82c10 8 40 8 50 0" stroke={a} strokeWidth="4" fill="none" opacity="0.6" />
        </g>
      ) : (
        Array.from({ length: keys }, (_, i) => {
          const x = 30 + (i % 3) * 50;
          const y = 52 + Math.floor(i / 3) * 56;
          return (
            <g key={i} transform={`translate(${x} ${y})`}>
              <rect width="40" height="40" rx="9" fill={c} opacity={0.92 - i * 0.07} />
              <rect x="5" y="4" width="30" height="26" rx="6" fill={b} opacity="0.55" />
              <circle cx={14 + (i % 2) * 10} cy="16" r="4" fill={a} opacity="0.7" />
            </g>
          );
        })
      )}
    </svg>
  );
}

// ---------------------------------------------------------------- status

const STATUS: Record<string, [string, string]> = {
  awaiting_person: ["Waiting for the person to approve in PayPal", "wait"],
  authorizing: ["Placing hold…", "wait"],
  held: ["Hold placed — you're in the ballot", "ok"],
  duplicate: ["No hold placed — this PayPal account already has an entry", "warn"],
  merged: ["Merged with your household/operation — hold released", "warn"],
  won: ["Selected! Capturing payment…", "ok"],
  waitlist: ["On the waitlist — your hold stays until units are paid", "wait"],
  lost: ["Not selected — hold being released", "muted"],
  voided: ["Not selected — hold released, never charged", "muted"],
  captured: ["You got one! Paid & confirmed", "win"],
  capture_failed: ["Payment failed — unit passed to the waitlist", "bad"],
  expired: ["Not approved in time — no hold was placed", "muted"],
  error: ["PayPal could not place the hold", "bad"],
};

export function StatusPill({ status }: { status: string }) {
  const [label, tone] = STATUS[status] ?? [status, "muted"];
  return <span className={`pill pill-${tone}`}>{label}</span>;
}

export function ShortStatus({ status }: { status: string }) {
  const tone = (STATUS[status] ?? ["", "muted"])[1];
  return <span className={`pill pill-${tone} pill-sm`}>{status.replace("_", " ")}</span>;
}

// ---------------------------------------------------------------- live ticker

export function Ticker({ slug, title = "Live ledger", sellerView = false }: { slug: string; title?: string; sellerView?: boolean }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  useEffect(() => {
    let alive = true;
    let last = 0;
    const load = async () => {
      try {
        const r = await api<{ events: EventRow[] }>(`/api/drops/${slug}/events?after=${last}`);
        if (!alive || !r.events.length) return;
        last = r.events[r.events.length - 1].id;
        setEvents((prev) => [...prev, ...r.events].slice(-120));
      } catch {
        /* ignore */
      }
    };
    void load();
    const t = setInterval(load, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [slug]);
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [events.length]);
  return (
    <section className="card ticker">
      <div className="card-head">
        <h3>{title}</h3>
        <span className="legend">
          <span className="tag tag-real">PayPal sandbox API</span>
          <span className="tag tag-sim">simulated / local</span>
        </span>
      </div>
      <ol ref={ref}>
        {events.length === 0 && <li className="muted">Nothing yet.</li>}
        {events.map((e) => (
          <li key={e.id} className={e.real ? "ev-real" : "ev-sim"}>
            <time>{new Date(e.ts).toLocaleTimeString()}</time>
            <span className={`tag ${e.real ? "tag-real" : "tag-sim"}`}>{e.real ? "PayPal" : sellerView ? "local" : "local"}</span>
            <span className="ev-msg">{e.message}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- PayPal JS SDK v6 button
// Adapted from paypal-examples/v6-web-sdk-sample-integration (Apache-2.0): the order promise is passed to
// session.start() WITHOUT awaiting it first, so the popup keeps its user-activation.

let sdkPromise: Promise<any> | null = null;
async function sdk(): Promise<any> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const ns = await loadCoreSdkScript({ environment: "sandbox" });
      if (!ns) throw new Error("PayPal SDK failed to load");
      const { clientId } = await api<{ clientId: string }>("/api/config");
      const instance = await (ns as any).createInstance({ clientId, components: ["paypal-payments"], pageType: "checkout" });
      return instance;
    })();
  }
  return sdkPromise;
}

export function PayPalEntryButton({ slug, onEntry }: { slug: string; onEntry: (p: Participant, outcome: string) => void }) {
  const ref = useRef<HTMLElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "busy" | "error">("loading");
  const [msg, setMsg] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const instance = await sdk();
        const methods = await instance.findEligibleMethods({ currencyCode: "USD" });
        if (!methods.isEligible("paypal")) throw new Error("PayPal is not eligible in this browser");
        const session = instance.createPayPalOneTimePaymentSession({
          async onApprove(data: { orderId: string }) {
            setState("busy");
            setMsg("Approved — checking your PayPal account and placing the hold…");
            const r = await api<{ outcome: string; entry: Participant }>("/api/entries/finalize", { method: "POST", json: { orderId: data.orderId } });
            setState("ready");
            setMsg("");
            onEntry(r.entry, r.outcome);
          },
          onCancel() {
            setState("ready");
            setMsg("Cancelled — no hold was placed.");
          },
          onError(err: unknown) {
            console.error(err);
            setState("ready");
            setMsg("PayPal reported an error. Please try again.");
          },
        });
        if (cancelled || !ref.current) return;
        const el = ref.current;
        el.removeAttribute("hidden");
        el.onclick = async () => {
          setMsg("");
          const orderPromise = api<{ orderId: string }>(`/api/drops/${slug}/entries`, { method: "POST" }).then((r) => ({ orderId: r.orderId }));
          try {
            await session.start({ presentationMode: "auto" }, orderPromise);
          } catch (e) {
            console.error(e);
            setMsg(e instanceof Error ? e.message : "Could not open PayPal");
          }
        };
        setState("ready");
      } catch (e) {
        console.error(e);
        setState("error");
        setMsg(e instanceof Error ? e.message : "PayPal failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, onEntry]);

  return (
    <div className="pp-wrap">
      {state === "loading" && <div className="skeleton">Loading PayPal…</div>}
      <paypal-button ref={ref as any} type="pay" hidden />
      {msg && <p className={state === "error" ? "err" : "hint"}>{msg}</p>}
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

export function Hash({ value, label }: { value: string | null | undefined; label: string }) {
  return (
    <div className="hash">
      <span>{label}</span>
      <code title={value ?? ""}>{value ? `${value.slice(0, 16)}…${value.slice(-8)}` : "—"}</code>
    </div>
  );
}
