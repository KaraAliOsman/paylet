// Pure model of a fan's hold, step by step. Shared by /d, /me and the agent HandoffCard (no React here, so it is easy to test).
import { clock, usd, usdShort, type EntryTimeline } from "./api";

export type StepState = "done" | "current" | "todo" | "bad" | "win";

export interface Step {
  key: "requested" | "approved" | "hold" | "draw" | "outcome";
  label: string;
  detail?: string;
  state: StepState;
  at?: number | null;
}

export interface TimelineInput {
  status: string;
  holdCents: number | null;
  capturedCents: number | null;
  refundedCents?: number | null;
  timeline?: EntryTimeline;
  closesAt: number;
  dropStatus: string;
  agentLabel?: string | null;
}

const PRE_DRAW = new Set(["awaiting_person", "authorizing", "held"]);
const SELECTED = new Set(["won", "captured", "capture_failed", "refunded"]);

export function holdSteps(i: TimelineInput, opts: { compact?: boolean } = {}): Step[] {
  const s = i.status;
  const t = i.timeline;
  const hold = i.holdCents;
  const steps: Step[] = [];

  steps.push({
    key: "requested",
    label: "Requested",
    detail: opts.compact ? undefined : i.agentLabel ? `by your agent ${i.agentLabel}` : undefined,
    state: "done",
    at: t?.requestedAt,
  });

  // 2 · the person approves in PayPal (agents can't)
  if (s === "awaiting_person") steps.push({ key: "approved", label: "You approve in PayPal", detail: opts.compact ? undefined : "Only you can approve. Agents can't.", state: "current" });
  else if (s === "expired") steps.push({ key: "approved", label: "Not approved in time", detail: "No hold was placed. $0 charged.", state: "bad" });
  else steps.push({ key: "approved", label: "Approved in PayPal", detail: !opts.compact && i.agentLabel ? "By you, not the agent." : undefined, state: "done", at: t?.approvedAt });
  if (s === "expired") return steps;

  // 3 · the hold
  const holdLabel = hold != null ? `Hold ${usdShort(hold)} placed` : "Hold placed";
  if (s === "awaiting_person") steps.push({ key: "hold", label: holdLabel, state: "todo" });
  else if (s === "authorizing") steps.push({ key: "hold", label: "Placing the hold", detail: opts.compact ? undefined : "PayPal is authorizing it now.", state: "current" });
  else if (s === "duplicate")
    return [...steps, { key: "hold", label: "No hold placed", detail: "This PayPal account already has an entry in this drop. $0 charged.", state: "bad" }];
  else if (s === "error") return [...steps, { key: "hold", label: "PayPal couldn't place the hold", detail: "Nothing was charged.", state: "bad" }];
  else steps.push({ key: "hold", label: holdLabel, detail: !opts.compact && (s === "held" || s === "waitlist") ? "Nothing charged yet." : undefined, state: "done", at: t?.heldAt });

  // 4 · the draw
  const drawAt = `Draw ${clock(i.closesAt)}`;
  if (s === "merged")
    return [...steps, { key: "draw", label: "Merged before the draw", detail: "One unit per household or operation. Hold released, $0 charged.", state: "bad" }];
  if (PRE_DRAW.has(s)) {
    const frozen = i.dropStatus === "frozen" || i.dropStatus === "drawn";
    steps.push({
      key: "draw",
      label: frozen ? "Drawing now" : drawAt,
      detail: frozen ? "List frozen. Waiting for public randomness (drand)." : "Public randomness picks the winners.",
      state: s === "held" ? "current" : "todo",
    });
  } else if (SELECTED.has(s)) steps.push({ key: "draw", label: "Selected", state: "done", at: t?.drawAt });
  else if (s === "waitlist") steps.push({ key: "draw", label: "On the waitlist", detail: "You get a unit only if a winner's payment fails.", state: "done", at: t?.drawAt });
  else steps.push({ key: "draw", label: "Not selected", state: "done", at: t?.drawAt });

  // 5 · the money
  const released = hold != null && i.capturedCents != null ? hold - i.capturedCents : null;
  switch (s) {
    case "captured":
      steps.push({
        key: "outcome",
        label: `Captured ${usd(i.capturedCents)}${released && released > 0 ? ` + ${usd(released)} released` : ""}`,
        detail: opts.compact ? undefined : "Price plus the real shipping. The rest of the hold went back.",
        state: "win",
        at: t?.settledAt,
      });
      break;
    case "refunded":
      steps.push({ key: "outcome", label: `Refunded ${usd(i.refundedCents ?? i.capturedCents)}`, detail: "You owe nothing.", state: "done", at: t?.settledAt });
      break;
    case "won":
      steps.push({ key: "outcome", label: "Capturing your payment", state: "current" });
      break;
    case "capture_failed":
      steps.push({ key: "outcome", label: "Payment failed → unit passed on", detail: "Your hold was released. $0 charged.", state: "bad", at: t?.settledAt });
      break;
    case "lost":
      steps.push({ key: "outcome", label: "Releasing your hold", detail: "$0 charged.", state: "current" });
      break;
    case "voided":
      steps.push({ key: "outcome", label: "Voided, $0 charged", detail: opts.compact ? undefined : "PayPal released the whole hold.", state: "done", at: t?.settledAt });
      break;
    case "waitlist":
      steps.push({ key: "outcome", label: "Waiting for the winners to pay", detail: "If nobody's payment fails, your hold is voided: $0.", state: "current" });
      break;
    default:
      steps.push({ key: "outcome", label: "Charged only if you win", detail: opts.compact ? undefined : "Not selected? Hold voided, $0.", state: "todo" });
  }
  return steps;
}

/** When an approval link stops working: PayPal orders expire 3 h after creation, and the drop may close first. */
export function approvalExpiresAt(requestedAt: number | undefined, closesAt: number): number {
  return requestedAt ? Math.min(requestedAt + 3 * 3600_000, closesAt) : closesAt;
}
