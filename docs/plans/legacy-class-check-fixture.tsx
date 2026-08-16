/* Fixture for `legacy-class-check.sh --self-test`. Not compiled: it lives
   outside apps/web/src, so no tsconfig include reaches it.

   It hides exactly two legacy class names — `card` and `pageHead` — inside a
   `cn(` call whose arguments wrap across lines, which is the shape a
   line-oriented `grep -oE 'className=\{[^}]*\}'` cannot see. If the extractor
   ever regresses to line matching, the self-test reports 0 instead of 2.

   Everything else here is a shape that must NOT count: ordinary utilities whose
   segments happen to spell a legacy name (`top-4`, `bg-primary`), a partly
   dynamic token (`btn${size}`), a legacy name that is a plain string somewhere
   other than a className, and a legacy name in a comment. */

const size = "sm";
const tone = "emerald";

export const Fixture = () => (
  <div className="flex items-start gap-2">
    <span className="absolute top-4 right-4 bg-primary" />
    <span className={`btn${size}`} />
    {/* Every string literal inside a className expression is scanned, including
        an operand like this one — the checker over-reports rather than miss
        residue, so keep non-class literals here clear of legacy names. */}
    <span className={tone === "emerald" ? "text-[color:var(--status-green-fg)]" : "text-muted-foreground"} />
    <button
      type="button"
      className={cn(
        "rounded-lg border border-border",
        "card",
        isOpen && "pageHead",
      )}
    >
      {/* card pageHead — a comment, not a className */}
      {label("card")}
    </button>
  </div>
);
