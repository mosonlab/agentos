import * as React from "react"

import { cn } from "@/lib/utils"

/** Colour, padding, radius and font-size reproduce the retired stylesheet's
 *  `input[type=…] { padding: 9px 11px; font-size: 12.5px; … }` rule.
 *
 *  `h-9` stays, against plan §1.5. That section reasons that an Input is 38.75px
 *  today (9 + 9 padding + 2 border + a 18.75px line box) and would collapse to
 *  `h-9` when the legacy rule is deleted. The legacy rule sets `padding`, not
 *  `height`, so it never overrode `h-9` in the first place: with border-box
 *  sizing an Input has always rendered at 29.25px, its line box overflowing the
 *  content edge. Measured against the pre-change baseline — the comment Input
 *  on TaskDetail is 29px there and 39px without this class.
 *
 *  `shadow-sm` stays: nothing unlayered sets `box-shadow`, so it is live on every
 *  Input host today and dropping it would be a visible regression (plan §2.5).
 *  `md:text-sm` is gone, because it would re-win over the pinned size at ≥768px.
 *
 *  v4 generation, one deviation: the stock string carries
 *  `focus-visible:border-ring`, which this file does not take. `focus:border-primary`
 *  below is the repo's own reproduction of the retired `input:focus` rule, and the
 *  repo string wins over the v4 base (batch 1 plan C1). Only the ring changes: the
 *  1px `ring-ring` becomes the sanctioned 3px `ring-ring/50`. */
function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-9 w-full rounded-lg border border-border bg-[color:var(--surface-input)] px-[11px] py-[9px] text-[12.5px] text-foreground outline-0 shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus:border-primary focus-visible:outline-hidden focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Input }
