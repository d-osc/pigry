/** Circular context-window indicator — a thin ring whose arc fills with the
 * used percentage (faded track + colored arc, Copilot-style). Color comes
 * from the wrapper's `color` (ai-ctx tone classes), so the ring and the %
 * text next to it always match. */
export function CtxRing({
  pct,
  size = 14,
  stroke = 2.5,
}: {
  pct: number;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const filled = (Math.min(100, Math.max(0, pct)) / 100) * circumference;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="ai-ctx-ring"
      aria-hidden="true"
    >
      <circle
        className="ai-ctx-ring__track"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth={stroke}
      />
      <circle
        className="ai-ctx-ring__fill"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth={stroke}
        strokeDasharray={`${filled} ${circumference - filled}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
