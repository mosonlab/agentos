import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/** The `legacy*` variants and the `legacy*` sizes reproduce `.btn` / `.iconBtn`
 *  from the retired stylesheet exactly (plan Appendix A.3). Each one pins its own
 *  `font-*`, `shadow*` and `disabled:opacity-*`: the base string below sets
 *  `font-medium`, `text-sm` and `disabled:opacity-50`, which are masked today by
 *  the unlayered `button { font: inherit }` rule and would wake up the moment
 *  that rule moves into `@layer base` (plan §2.5).
 *
 *  `disabled:pointer-events-auto` goes with `disabled:cursor-not-allowed` on the
 *  `.btn` variants and is not redundant with it: the base string's
 *  `disabled:pointer-events-none` makes the element inert to the pointer, so its
 *  own `cursor` never applies and the parent's shows instead. `.btn:disabled
 *  { opacity:.45; cursor:not-allowed }` and `.btn:hover` both applied at baseline
 *  — nothing there removed pointer events — so restoring them is the R-1 answer.
 *  A disabled <button> dispatches no click either way, so this is presentation
 *  only. `variant.icon` is left alone: `.iconBtn` had no `:disabled` rule. */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        legacy:
          "border border-border bg-card text-secondary-foreground shadow font-normal disabled:opacity-45 disabled:pointer-events-auto disabled:cursor-not-allowed hover:border-[color:var(--border-hover)] hover:bg-secondary hover:text-foreground",
        legacyPrimary:
          "border border-primary bg-primary text-primary-foreground shadow font-bold disabled:opacity-45 disabled:pointer-events-auto disabled:cursor-not-allowed hover:bg-[color:var(--primary-hover)] hover:border-[color:var(--primary-hover)]",
        /** `.btn.danger` runs on --danger-button*, not on the stock `destructive`
         *  variant: that variant emits `text-destructive-foreground`, and no such
         *  token exists in :root/.dark, so the class is never generated. */
        legacyDanger:
          "border border-[color:var(--destructive-line)] bg-[color:var(--danger-button)] text-[color:var(--danger-button-foreground)] shadow font-bold disabled:opacity-45 disabled:pointer-events-auto disabled:cursor-not-allowed hover:bg-[color:var(--danger-button-hover)]",
        /** `.iconBtn`'s only host is a raw <button>, which has no box-shadow
         *  today, so `shadow-none` belongs in the variant rather than at the one
         *  call site. */
        icon:
          "grid place-items-center border-0 bg-transparent shadow-none font-normal text-muted-foreground disabled:opacity-45 hover:bg-secondary hover:text-foreground",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
        /** The phone heights are the 44px finger target, and they are `min-h`
         *  rather than `h`: a call site that passes `h-auto` — the onboarding
         *  wizard does — must still clear it. Type size is untouched, so the
         *  button reads the same and only its padding grows. */
        legacy: "h-[34px] gap-[7px] px-[13px] text-[12.5px] rounded-lg whitespace-nowrap [@media(max-width:900px)]:min-h-[44px]",
        legacySmall: "h-[28px] gap-[7px] px-[10px] text-[12px] rounded-lg [@media(max-width:900px)]:min-h-[44px]",
        legacyIcon: "size-[28px] rounded-[7px] text-[13px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
