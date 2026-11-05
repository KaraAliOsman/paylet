// Small shared UI pieces: toasts (P0-06), a confirm dialog, and the Drop report (P1-07).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { apiOptional, nf, usd, type DropReport } from "./api";
import { AlertIcon, BotIcon, CheckIcon, ClockIcon, CrossIcon, ReceiptIcon, RefundIcon, ShieldIcon } from "./icons";
import { Link } from "./router";

// ---------------------------------------------------------------- toasts: role=status, friendly copy, technical details folded

export interface Toast {
  id: number;
  tone: "ok" | "warn" | "bad" | "info";
  text: string;
  details?: string;
  action?: { label: string; onClick: () => void };
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = ++seq.current;
      setToasts((l) => [...l.slice(-2), { ...t, id }]);
      // good news fades; problems stay until dismissed
      if (t.tone === "ok" || t.tone === "info") setTimeout(() => dismiss(id), 7000);
      return id;
    },
    [dismiss],
  );
  return { toasts, push, dismiss };
}

export function ToastRegion({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`} data-testid="toast" data-tone={t.tone}>
          <span className="toast-icon" aria-hidden="true">
            {t.tone === "ok" ? <CheckIcon size={16} /> : t.tone === "info" ? <ClockIcon size={16} /> : <AlertIcon size={16} />}
          </span>
          <div className="toast-body">
            <p>{t.text}</p>
            {t.action && (
              <button
                className="linklike"
                onClick={() => {
                  onDismiss(t.id);
                  t.action!.onClick();
                }}
              >
                {t.action.label}
              </button>
            )}
            {t.details && (
              <details>
                <summary>Details</summary>
                <code>{t.details}</code>
              </details>
            )}
          </div>
          <button className="toast-x" aria-label="Dismiss" onClick={() => onDismiss(t.id)}>
            <CrossIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- confirm dialog (native <dialog>: focus trap and Esc for free)

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  tone = "primary",
  disabled = false,
  onConfirm,
  onClose,
  testId = "confirm",
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
  disabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby={`${testId}-title`} onClose={onClose} data-testid={testId}>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!disabled) onConfirm();
          }}
        >
          <h3 id={`${testId}-title`}>{title}</h3>
          <div className="dialog-body">{children}</div>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose} data-testid="confirm-cancel">
              Cancel
            </button>
            <button type="submit" className={`btn ${tone === "danger" ? "btn-danger" : "btn-primary"}`} disabled={disabled} data-testid="confirm-ok">
              {confirmLabel}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

// ---------------------------------------------------------------- Drop report (P1-07)

export function useReport(slug: string, settled: boolean): DropReport | null {
  const [r, setR] = useState<DropReport | null>(null);
  useEffect(() => {
    if (!settled) return;
    let alive = true;
    apiOptional<DropReport>(`/api/drops/${slug}/report`)
      .then((x) => alive && setR(x))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [slug, settled]);
  return r;
}

const plural = (n: number, one: string, many = `${one}s`) => `${nf(n)} ${n === 1 ? one : many}`;

/**
 * "2 units → 2 different PayPal payers · $89.00 captured · $7.00 of unused shipping released" and three more lines.
 * Rendered once the drop is settled (console, /verify and the fan page). Nothing shows on a server without /report.
 */
export function SettlementSummary({ slug, settled, judge = false, showVerify = true }: { slug: string; settled: boolean; judge?: boolean; showVerify?: boolean }) {
  const r = useReport(slug, settled);
  if (!settled || !r) return null;
  const id = `report-${slug}`;
  return (
    <section className="card report" aria-labelledby={id} data-testid="settlement-summary">
      <div className="card-head">
        <h3 id={id}>
          <ReceiptIcon size={18} /> Drop report
        </h3>
        <span className={`tag ${r.real ? "tag-real" : "tag-sim"}`}>{r.real ? "includes real PayPal sandbox money" : "simulated entrants only (labelled)"}</span>
      </div>
      <ul className="report-lines">
        <li>
          <span className="report-ico is-ok">
            <CheckIcon size={16} />
          </span>
          <span>
            <b>{plural(r.units, "unit")}</b> → <b>{plural(r.unitsToDistinctPayers, "different PayPal payer")}</b> · <b>{usd(r.capturedCents)}</b> captured
            {r.shippingReleasedCents > 0 && (
              <>
                {" "}
                · <b>{usd(r.shippingReleasedCents)}</b> of unused shipping released
              </>
            )}
          </span>
        </li>
        <li>
          <span className="report-ico is-ok">
            <ShieldIcon size={16} />
          </span>
          <span>
            {r.holdsVoided ? (
              <>
                <b>{plural(r.holdsVoided, "hold")}</b> voided · <b>{usd(r.chargedToLosersCents).replace(".00", "")}</b> charged to anyone who lost
              </>
            ) : (
              <>Nobody else held a hold in this run, so there was nothing to void</>
            )}
          </span>
        </li>
        {r.failedPayments > 0 && (
          <li>
            <span className="report-ico is-warn">
              <RefundIcon size={16} />
            </span>
            <span>
              <b>{plural(r.failedPayments, "failed payment")}</b> →{" "}
              {r.waitlistRecoverySeconds != null ? (
                <>
                  waitlist #1 got the unit in <b>{nf(Math.max(1, Math.round(r.waitlistRecoverySeconds)))} s</b>
                </>
              ) : (
                <>the unit passed to the waitlist</>
              )}
            </span>
          </li>
        )}
        <li>
          <span className="report-ico">
            <BotIcon size={16} />
          </span>
          <span>
            <b>{plural(r.agentRequests, "agent request")}</b> → <b>{nf(r.agentHoldsWithoutPerson)}</b> holds without a person
            {r.networkAccounts > 0 && (
              <>
                {" "}
                · <b>{plural(r.networkAccounts, "network account")}</b> → <b>{plural(r.networkTickets, "ticket")}</b>
              </>
            )}
            {r.sameAccountDuplicates > 0 && (
              <>
                {" "}
                · <b>{nf(r.sameAccountDuplicates)}</b> same-account duplicate{r.sameAccountDuplicates === 1 ? "" : "s"} blocked
              </>
            )}
          </span>
        </li>
      </ul>
      {(showVerify || judge) && (
        <div className="row gap wrap">
          {showVerify && (
            <Link className="btn btn-primary" href={`/verify/${slug}`}>
              Verify this draw
            </Link>
          )}
          {judge && (
            <Link className="btn" href="/judge?fresh=1">
              Start another judge drop
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
