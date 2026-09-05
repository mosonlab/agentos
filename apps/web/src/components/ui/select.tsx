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
 *  `pr-*` when it sees `px-*`, not the other way round.
 *
 *  v4 generation: same one deviation as `input.tsx` — no `focus-visible:border-ring`,
 *  because `focus:border-primary` is the repo's own rule and wins over the v4 base. */
function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "flex w-full [@media(max-width:900px)]:min-h-[44px] appearance-none rounded-lg border border-border bg-[color:var(--surface-input)] px-[11px] py-[9px] text-[12.5px] text-foreground outline-0 shadow-sm transition-colors focus:border-primary focus-visible:outline-hidden focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-50",
        "bg-[image:linear-gradient(45deg,transparent_50%,var(--faint)_50%),linear-gradient(135deg,var(--faint)_50%,transparent_50%)] bg-[position:right_14px_top_15px,right_9px_top_15px] bg-[size:5px_5px] bg-no-repeat pr-[30px]",
        /* The chevron is painted from the top edge, so the phone height moves it
         * off centre unless it is re-placed against the taller box. */
        "[@media(max-width:900px)]:bg-[position:right_14px_top_19px,right_9px_top_19px]",
        className
      )}
      {...props}
    />
  )
}

export { Select }
