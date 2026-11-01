import { useEffect, useRef } from "react";
// The same file the README shows; inlined so its colours follow the page tokens (var(--real) etc.).
import sequenceSvg from "../../docs/img/sequence.svg?raw";

/**
 * Paylet ↔ PayPal sequence diagram. With `reveal`, the eight steps (g.step-1 … g.step-8) appear one by one
 * every `stepMs` (used by /how?reveal=1 for the video); otherwise everything is visible.
 */
export function SequenceDiagram({ reveal = false, stepMs = 1600 }: { reveal?: boolean; stepMs?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const svg = ref.current?.querySelector("svg");
    if (!svg || !reveal) return;
    svg.classList.add("reveal");
    let n = 0;
    const t = setInterval(() => {
      n++;
      svg.querySelectorAll(`.step-${n}`).forEach((g) => g.classList.add("on"));
      if (n >= 8) clearInterval(t);
    }, stepMs);
    return () => {
      clearInterval(t);
      svg.classList.remove("reveal");
      svg.querySelectorAll(".seq-step").forEach((g) => g.classList.remove("on"));
    };
  }, [reveal, stepMs]);
  return <div ref={ref} className="seq-wrap" dangerouslySetInnerHTML={{ __html: sequenceSvg }} />;
}
