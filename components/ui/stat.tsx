/**
 * One figure in a stat grid.
 *
 * Promoted out of the earnings calculator because `StatRowSkeleton` in
 * `states.tsx` already hardcodes the same four-up grid markup, so the shape
 * was implicitly shared. A real component keeps the skeleton and the content
 * in step.
 */
export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  /** Use sparingly. Green on a projected figure reads as money received, so
   *  counterfactual numbers stay untoned. */
  tone?: "ok" | "warn";
}) {
  const cls =
    tone === "ok" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : "";
  return (
    <div className="bg-surface px-4 py-3">
      <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
        {label}
      </div>
      <div className={`mt-1 text-xl font-mono tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="text-xs text-cream-30 font-mono mt-0.5">{sub}</div>}
    </div>
  );
}
