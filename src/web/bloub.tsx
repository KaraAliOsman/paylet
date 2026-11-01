/**
 * Wren's avatar: a plain black circle with two white eyes, in the spirit of the bloub bot (github.com/jeremy-prt/bloub):
 * one solid body, two eyes that lean the same way (about 26° off vertical), gaze drift and a blink at rest, and no
 * overshoot anywhere. Pure SVG + CSS, no library, no gradient.
 */
export function Bloub({ size = 40, busy = false, label = "Wren" }: { size?: number; busy?: boolean; label?: string }) {
  return (
    <svg
      className={`bloub${busy ? " is-busy" : ""}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={label}
      focusable="false"
    >
      <circle className="bloub-body" cx="50" cy="50" r="50" />
      <g className="bloub-eyes">
        {/* the lean lives on a parent group, so the blink (a CSS transform on the ellipse) never overrides it */}
        <g transform="rotate(-26 37 48)">
          <ellipse className="bloub-eye" cx="37" cy="48" rx="7.4" ry="14" />
        </g>
        <g transform="rotate(-26 63 48)">
          <ellipse className="bloub-eye" cx="63" cy="48" rx="7.4" ry="14" />
        </g>
      </g>
    </svg>
  );
}
