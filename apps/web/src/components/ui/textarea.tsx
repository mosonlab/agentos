import * as React from "react"

import { cn } from "@/lib/utils"

/** Same treatment as `input.tsx` (plan §1.5, §2.5), plus the retired
 *  `textarea { resize: vertical; line-height: 1.6 }` rule. `shadow-sm` and
 *  `min-h-[60px]` both stay: the shadow is live today, and the min-height is
 *  inert at every current call site (all are `rows >= 4`), so keeping it costs
 *  nothing and removes a way to be wrong.
 *
 *  v4 generation: same one deviation as `input.tsx` — no `focus-visible:border-ring`,
 *  because `focus:border-primary` is the repo's own rule and wins over the v4 base. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-[60px] w-full resize-y rounded-lg border border-border bg-[color:var(--surface-input)] px-[11px] py-[9px] text-[12.5px] leading-[1.6] text-foreground outline-0 shadow-sm placeholder:text-muted-foreground focus:border-primary focus-visible:outline-hidden focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
