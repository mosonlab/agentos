import * as React from "react"

import { cn } from "@/lib/utils"

/** Same treatment as `input.tsx` (plan §1.5, §2.5), plus the retired
 *  `textarea { resize: vertical; line-height: 1.6 }` rule. `shadow-sm` and
 *  `min-h-[60px]` both stay: the shadow is live today, and the min-height is
 *  inert at every current call site (all are `rows >= 4`), so keeping it costs
 *  nothing and removes a way to be wrong. */
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-[60px] w-full resize-y rounded-lg border border-border bg-[color:var(--surface-input)] px-[11px] py-[9px] text-[12.5px] leading-[1.6] text-foreground outline-0 shadow-sm placeholder:text-muted-foreground focus:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
