import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/** `shape="pill"` + `tone` reproduce `.pill` and its six tone modifiers from the
 *  retired stylesheet (plan Appendix A.5). `shape` is declared before `tone` on
 *  purpose: cva emits variant groups in declaration order, so a tone's
 *  border-colour has to come after the shape's `border-transparent` to win under
 *  tailwind-merge. */
const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
      },
      shape: {
        /** `border-transparent` is not redundant: `.pill`'s base is
         *  `border: 1px solid transparent`, and Tailwind's bare `border` leaves
         *  the colour at currentColor, so a toneless pill would draw a border it
         *  does not draw today. */
        pill: "inline-flex items-center gap-[5px] rounded-full border border-transparent px-[9px] py-[2px] text-[11px] leading-[18px] whitespace-nowrap font-normal",
      },
      tone: {
        green: "border-[color:var(--status-green-line)] bg-[color:var(--status-green-bg)] text-[color:var(--status-green-fg)]",
        amber: "border-[color:var(--status-amber-line)] bg-[color:var(--status-amber-bg)] text-[color:var(--status-amber-fg)]",
        violet: "border-[color:var(--status-violet-line)] bg-[color:var(--status-violet-bg)] text-[color:var(--status-violet-fg)]",
        red: "border-[color:var(--destructive-line)] bg-[color:var(--destructive-bg)] text-[color:var(--destructive-fg)]",
        grey: "border-border bg-secondary text-muted-foreground",
        accent: "border-[color:var(--primary-soft)] bg-[color:var(--primary-badge-background)] text-primary",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, shape, tone, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant, shape, tone }), "font-normal", className)} {...props} />
  )
}

export { Badge, badgeVariants }
