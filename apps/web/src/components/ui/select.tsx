import * as React from "react"

import { cn } from "@/lib/utils"

/** Native `<select>`, deliberately not Radix (spec §5.4): the app's twelve
 *  selects are plain single-value pickers and a Radix Select would be component
 *  work with its own test surface.
 *
 *  Geometry matches `input.tsx` exactly — including `shadow-sm`, so a select
 *  matches the Input next to it — plus the two-gradient chevron ported verbatim
 *  from the retired stylesheet's `select { background-image: … }` rule. Note the
 *  alias substitution `--fg-faint` -> `--faint` (plan §2.1).
 *
 *  `pr-[30px]` is written after `px-[11px]`: tailwind-merge drops a preceding
 *  `pr-*` when it sees `px-*`, not the other way round. */
const Select = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>(
  ({ className, ...props }, ref) => {
    return (
      <select
        className={cn(
          "flex w-full appearance-none rounded-lg border border-border bg-[color:var(--surface-input)] px-[11px] py-[9px] text-[12.5px] text-foreground outline-0 shadow-sm transition-colors focus:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          "bg-[image:linear-gradient(45deg,transparent_50%,var(--faint)_50%),linear-gradient(135deg,var(--faint)_50%,transparent_50%)] bg-[position:right_14px_top_15px,right_9px_top_15px] bg-[size:5px_5px] bg-no-repeat pr-[30px]",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Select.displayName = "Select"

export { Select }
