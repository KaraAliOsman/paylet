import { useEffect, type ReactNode } from "react";
import { Link } from "../router";
import { SequenceDiagram } from "../sequence";

export const REPO = "https://github.com/KaraAliOsman/paylet";

function Section({ title, code, children }: { title: string; code?: string; children: ReactNode }) {
  return (
    <section className="how-sec">
      <div className="how-h">
        <h3>{title}</h3>
        {code && (
          <a className="code-link" href={`${REPO}/${code.endsWith("/") ? "tree" : "blob"}/main/${code}`} target="_blank" rel="noopener">
            Where in the code → <code>{code}</code>
          </a>
        )}
      </div>
      {children}
    </section>
  );
}

const FAQ: [string, ReactNode][] = [
  [
    "Is this a raffle?",
    <>
      No. Entering is free and nobody pays for a chance. Winners buy the item at its list price (an allocation ballot, like sneaker draws), and everyone else's
      hold is voided without a charge.
    </>,
  ],
  [
    "Is a PayPal account proof of a unique human?",
    <>
      No. One person can hold several PayPal accounts. Paylet makes every extra entry cost a separate PayPal account that can really be charged, flags
      households and reseller networks for the seller (the AI suggests, the seller decides), and keeps every decision auditable. It raises the cost of scalping;
      it doesn't make it impossible.
    </>,
  ],
  [
    "Can my AI agent pay for me?",
    <>
      No. An agent can find drops and request an entry over MCP. It gets a PayPal approval link and has to hand it to you: the hold only exists once you approve
      it in PayPal.
    </>,
  ],
  [
    "Why is the hold bigger than the price?",
    <>
      The hold covers the price plus the maximum shipping. A winner is charged the price plus the real shipping (a partial capture) and PayPal releases the rest
      of the hold. Everyone else is charged $0.
    </>,
  ],
  [
    "What happens if a winner's payment fails?",
    <>
      The unit goes to the next fan on the waitlist, whose hold already exists, so it is captured in seconds. The winner whose payment failed is charged
      nothing.
    </>,
  ],
];

export function HowPage() {
  const reveal = new URLSearchParams(window.location.search).get("reveal") === "1";
  useEffect(() => {
    if (window.location.hash === "#sequence") document.getElementById("sequence")?.scrollIntoView();
  }, []);
  return (
    <div className="how">
      <section className="card how-top">
        <p className="eyebrow">How it works</p>
        <h1>Agents can enter. Only people can pay.</h1>
        <p className="lede">
          Every entry is a PayPal hold, one per PayPal account, and losers are never charged. Here is every call, in order. Blue arrows are real PayPal sandbox
          API calls.
        </p>
        <figure id="sequence" className="seq-fig">
          <SequenceDiagram reveal={reveal} />
          <figcaption className="muted small">
            <span className="swipe-hint">Swipe sideways to see PayPal. </span>Sequence for one entry. Also in the README:{" "}
            <a href={`${REPO}/blob/main/docs/img/sequence.svg`}>docs/img/sequence.svg</a>.
          </figcaption>
        </figure>
      </section>

      <section className="card narrow prose">
        <Section title="PayPal is the allocation key" code="src/server/domain.ts">
          <p>
            Every entry is a PayPal Orders v2 order with <code>intent: AUTHORIZE</code>. When the person approves, Paylet reads <code>payer.payer_id</code> from
            PayPal's own order record (server-side, never trusted from the browser), stores only an HMAC of it, and enforces a unique constraint per drop before
            calling <code>/authorize</code>. A second approval from the same account simply never gets a hold.
          </p>
        </Section>
        <Section title="Agents welcome, people pay" code="src/server/mcp.ts">
          <p>
            Paylet exposes an MCP server (<code>list_drops</code>, <code>enter_drop</code>, <code>entry_status</code>). An AI agent can list drops and request
            an entry, receiving a PayPal approval link. It cannot approve: the hold only exists once a person approves in PayPal.{" "}
            <Link href="/agent">Try it with Wren →</Link>
          </p>
        </Section>
        <Section title="AI where rules run out" code="src/server/er/">
          <p>
            Deterministic normalisation (USPS-style suffixes, unit designators, c/o, mailbox aliases) links the obvious cases. Only fuzzy pairs go to the model
            (MiMo V2.6 Pro, structured output), which must cite concrete fields. Nothing is auto-merged: the seller confirms, and fans can appeal.{" "}
            <Link href="/evals">See the evals →</Link>
          </p>
        </Section>
        <Section title="A draw nobody can steer" code="src/shared/draw.ts">
          <p>
            The seed's SHA-256 is published when the drop opens. At close, the eligible list is frozen and hashed, and Paylet commits to a future round of
            public randomness from the League of Entropy (drand). Once that round exists, <code>final seed = SHA-256(seed:randomness)</code> ranks every entry
            by <code>SHA-256(final seed:entry)</code>. Not even Paylet knows the winners before the round is published, and anyone can re-run the draw in their
            browser on the verify page.
          </p>
        </Section>
        <Section title="Honest settlement, retry-safe" code="src/server/queue.ts">
          <p>
            Winners are captured for the price plus real shipping (a partial capture), everyone else is voided. If a winner's payment fails, the next waitlisted
            entry, whose hold already exists, takes the unit. Every PayPal call goes through a persistent, throttled queue whose key is the{" "}
            <code>PayPal-Request-Id</code>, so a retry can never double-charge, and webhooks are signature-verified before they change anything.
          </p>
        </Section>

        <h2 className="faq-title">Questions</h2>
        <dl className="faq">
          {FAQ.map(([q, a]) => (
            <div key={q}>
              <dt>{q}</dt>
              <dd>{a}</dd>
            </div>
          ))}
        </dl>

        <h3>What this does NOT guarantee</h3>
        <ul>
          <li>
            A PayPal account is not proof of a unique human; one person can hold several accounts. Paylet raises the cost, it does not make scalping impossible.
          </li>
          <li>The seller could collude with a reseller; the frozen-list hash makes after-the-fact changes detectable, not impossible.</li>
          <li>PayPal authorizations have a 3-day honor period, so drops close within 48 hours.</li>
        </ul>
      </section>
    </div>
  );
}
