import * as React from "react"

import { cn } from "@/lib/utils"

function Card({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="card"
      className={cn(
        "rounded-xl border bg-card text-card-foreground shadow-none",
        className
      )}
      {...props}
    />
  )
}

export { Card }
