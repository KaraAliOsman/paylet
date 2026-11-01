import { clock, type Participant } from "./api";
import { holdSteps, type StepState, type TimelineInput } from "./timeline";

const SR: Record<StepState, string> = { done: "done", current: "in progress", todo: "not yet", bad: "stopped", win: "done" };

/** Builds the timeline input from a participant; `holdHint` fills in the hold before PayPal has placed it. */
export function timelineInput(p: Participant, holdHint?: number | null): TimelineInput {
  return {
    status: p.status,
    holdCents: p.holdCents ?? holdHint ?? null,
    capturedCents: p.capturedCents,
    refundedCents: p.refundedCents,
    timeline: p.timeline,
    closesAt: p.drop.closesAt,
    dropStatus: p.drop.status,
    agentLabel: p.source === "agent" ? p.agentLabel : null,
  };
}

/**
 * Requested → Approved in PayPal → Hold placed → Draw → Captured + released | Voided, $0 | Payment failed → passed on.
 * `compact` lays it out in a row (HandoffCard); `max` trims the steps shown.
 */
export function HoldTimeline({ input, compact = false, max }: { input: TimelineInput; compact?: boolean; max?: number }) {
  const steps = holdSteps(input, { compact }).slice(0, max);
  return (
    <ol className={`htl ${compact ? "htl-row" : ""}`} aria-label="Your hold, step by step">
      {steps.map((s) => (
        <li key={s.key} className={`htl-step is-${s.state}`} aria-current={s.state === "current" ? "step" : undefined}>
          <span className="htl-dot" aria-hidden="true" />
          <span className="htl-text">
            <b>{s.label}</b>
            <span className="sr-only"> ({SR[s.state]})</span>
            {s.detail && <small>{s.detail}</small>}
          </span>
          {!compact && s.at ? <time dateTime={new Date(s.at).toISOString()}>{clock(s.at)}</time> : null}
        </li>
      ))}
    </ol>
  );
}
