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
 *  content edge. Measured against docs/plans/baseline-screenshots — the comment
 *  Input on TaskDetail is 29px there and 39px without this class.
 *
 *  `shadow-sm` stays: nothing unlayered sets `box-shadow`, so it is live on every
 *  Input host today and dropping it would be a visible regression (plan §2.5).
 *  `md:text-sm` is gone, because it would re-win over the pinned size at ≥768px. */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type = "text", ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-lg border border-border bg-[color:var(--surface-input)] px-[11px] py-[9px] text-[12.5px] text-foreground outline-0 shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
