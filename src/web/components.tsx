import { useEffect, useRef, useState, type ReactNode } from "react";
import { loadCoreSdkScript } from "@paypal/paypal-js/sdk-v6";
import { api, friendlyError, type Participant } from "./api";
import { Link, navigate, usePath } from "./router";
import emberPhoto from "./assets/ember.jpg";
import tidepoolPhoto from "./assets/tidepool.jpg";

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
  const { path } = usePath();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  const onHero = path === "/" && !scrolled;
  return (
    <div className={`shell ${path === "/" ? "is-home" : path.startsWith("/agent") ? "is-agent" : "is-inner"}`}>
      <header className={`topbar ${onHero ? "topbar-hero" : ""} ${scrolled ? "is-scrolled" : ""}`}>
        <Link href="/" className="brand">
          <BrandMark />
          <span className="brand-word">paylet</span>
        </Link>
        <nav aria-label="Main">
          <Link href="/how" className="nav-how">
            How it works
          </Link>
          <Link href="/agent">Fan's agent</Link>
          <Link href="/evals" className="nav-evals">
            Evals
          </Link>
          <Link href="/judge" className="nav-cta">
            Try to scalp us
          </Link>
        </nav>
      </header>
      <main>{children}</main>
      <footer className="foot">
        <span className="foot-note">
          PayPal <b>sandbox</b> only · no real money moves · AI: MiMo V2.6 Pro
        </span>
        <span className="foot-links">
          <Link href="/how">How it works</Link> · <a href="https://github.com/KaraAliOsman/paylet">Source (MIT)</a>
        </span>
      </footer>
    </div>
  );
}

/** The Paylet mark: one unit (the dot) held between two brackets (the PayPal hold). The brackets close on hover. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path className="bm-l" d="M11.5 5.5H6.5v21h5" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinejoin="miter" />
      <path className="bm-r" d="M20.5 5.5h5v21h-5" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinejoin="miter" />
      <circle className="bm-dot" cx="16" cy="16" r="4.2" fill="#f5a400" />
    </svg>
  );
}

// ---------------------------------------------------------------- product images
// Real product photography for the two demo products (Unsplash License; credits in README); any other drop gets the
// generated artwork below.

const PHOTOS: Record<string, { src: string; alt: string }> = {
  ember: { src: emberPhoto, alt: "Ember Glaze Mug: a wheel-thrown stoneware cup, white glaze with a red ember brush mark" },
  tidepool: { src: tidepoolPhoto, alt: "Tidepool keycap set: off-white keycaps with mint, coral and blue modifiers" },
};

const ARTS: Record<string, [string, string, string]> = {
  tidepool: ["#0f4c5c", "#5fb3b3", "#f6c86a"],
  ember: ["#5b1e14", "#d9653b", "#f3d3a4"],
  default: ["#2d2350", "#8f7cf0", "#f6c86a"],
};

export function Art({ art, size = 220 }: { art: string; size?: number }) {
  const photo = PHOTOS[art];
  if (photo) {
    return (
      <img
        className="art art-photo"
        src={photo.src}
        alt={photo.alt}
        width={size}
        height={size}
        loading={size > 120 ? "eager" : "lazy"}
        decoding="async"
        style={{ borderRadius: Math.max(8, Math.round(size * 0.12)) }}
      />
    );
  }
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
  expired: ["No person approved: no hold placed", "muted"],
  error: ["PayPal could not place the hold", "bad"],
  refunded: ["Refunded — you owe nothing", "muted"],
};

export function StatusPill({ status }: { status: string }) {
  const [label, tone] = STATUS[status] ?? [status, "muted"];
  return <span className={`pill pill-${tone}`}>{label}</span>;
}

export function ShortStatus({ status }: { status: string }) {
  const tone = (STATUS[status] ?? ["", "muted"])[1];
  return <span className={`pill pill-${tone} pill-sm`}>{status.replace(/_/g, " ")}</span>;
}

// the ledger lives in ./ledger (trace chips, folded simulated rows)
export { Ticker } from "./ledger";

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
        let lastEntryId: string | null = null;
        const session = instance.createPayPalOneTimePaymentSession({
          async onApprove(data: { orderId: string }) {
            setState("busy");
            setMsg("Approved. Checking your PayPal account and placing the hold…");
            try {
              const r = await api<{ outcome: string; entry: Participant | null }>("/api/entries/finalize", { method: "POST", json: { orderId: data.orderId } });
              setState("ready");
              if (!r.entry) {
                setMsg("This demo server was reset since you opened the page — reload and try again (nothing was charged).");
                return;
              }
              setMsg("");
              onEntry(r.entry, r.outcome);
            } catch (e) {
              setState("ready");
              if (lastEntryId) navigate(`/me/${lastEntryId}`);
              else setMsg(`Couldn't confirm your entry. ${friendlyError(e)}`);
            }
          },
          onCancel() {
            setState("ready");
            setMsg("Cancelled. No hold was placed.");
          },
          onError(err: unknown) {
            console.error(err);
            setState("ready");
            setMsg("PayPal reported an error. Nothing was charged; please try again.");
          },
        });
        if (cancelled || !ref.current) return;
        const el = ref.current;
        el.removeAttribute("hidden");
        el.onclick = async () => {
          setMsg("");
          const orderPromise = api<{ orderId: string; entryId: string }>(`/api/drops/${slug}/entries`, { method: "POST" }).then((r) => {
            lastEntryId = r.entryId;
            return { orderId: r.orderId };
          });
          try {
            await session.start({ presentationMode: "auto" }, orderPromise);
          } catch (e) {
            console.error(e);
            setMsg("Couldn't open PayPal. Nothing was charged; try again.");
          }
        };
        setState("ready");
      } catch (e) {
        console.error(e);
        setState("error");
        setMsg("PayPal didn't load in this browser. Reload the page, or let your AI agent request the entry.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, onEntry]);

  return (
    <div className="pp-wrap">
      {state === "loading" && <div className="skeleton">Loading PayPal…</div>}
      {/* No `type`: the plain PayPal wordmark. "Pay with" / "Buy Now" / "Checkout" all contradict "charged only if you win". */}
      <paypal-button ref={ref as any} hidden />
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

/** Copy-to-clipboard button with a short "Copied" confirmation. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm btn-copy"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked: the value is selectable anyway */
        }
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

/** A full hash on its own line, selectable, with a Copy button. */
export function HashFull({ value, label, hint }: { value: string | null | undefined; label: string; hint?: string }) {
  return (
    <div className="hashfull">
      <div className="hashfull-head">
        <span>{label}</span>
        {value && <CopyButton value={value} label={label.toLowerCase()} />}
      </div>
      <code>{value ?? "—"}</code>
      {hint && <small>{hint}</small>}
    </div>
  );
}
