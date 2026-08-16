import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/** The `legacy*` variants and the `legacy*` sizes reproduce `.btn` / `.iconBtn`
 *  from the retired stylesheet exactly (plan Appendix A.3). Each one pins its own
 *  `font-*`, `shadow*` and `disabled:opacity-*`: the base string below sets
 *  `font-medium`, `text-sm` and `disabled:opacity-50`, which are masked today by
 *  the unlayered `button { font: inherit }` rule and would wake up the moment
 *  that rule moves into `@layer base` (plan §2.5). */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
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
          "border border-border bg-card text-secondary-foreground shadow font-normal disabled:opacity-45 hover:border-[color:var(--border-hover)] hover:bg-secondary hover:text-foreground",
        legacyPrimary:
          "border border-primary bg-primary text-primary-foreground shadow font-bold disabled:opacity-45 hover:bg-[color:var(--primary-hover)] hover:border-[color:var(--primary-hover)]",
        /** `.btn.danger` runs on --danger-button*, not on the stock `destructive`
         *  variant: that variant emits `text-destructive-foreground`, and no such
         *  token exists in :root/.dark, so the class is never generated. */
        legacyDanger:
          "border border-[color:var(--destructive-line)] bg-[color:var(--danger-button)] text-[color:var(--danger-button-foreground)] shadow font-bold disabled:opacity-45 hover:bg-[color:var(--danger-button-hover)]",
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
        legacy: "h-[34px] gap-[7px] px-[13px] text-[12.5px] rounded-lg whitespace-nowrap",
        legacySmall: "h-[28px] gap-[7px] px-[10px] text-[12px] rounded-lg",
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

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
