import * as React from "react"

import { cn } from "@/lib/utils"

/** Geometry and colour reproduce the retired stylesheet's
 *  `input[type=…] { padding: 9px 11px; font-size: 12.5px; … }` rule, so the ~26
 *  Input call sites keep their ≈38.75px height instead of collapsing to the stock
 *  `h-9` (29.25px) when that rule is deleted (plan §1.5).
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
          "flex w-full rounded-lg border border-border bg-[color:var(--surface-input)] px-[11px] py-[9px] text-[12.5px] text-foreground outline-0 shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
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
