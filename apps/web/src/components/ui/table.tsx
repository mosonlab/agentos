import * as React from "react"

import { cn } from "@/lib/utils"

/** `leading-[1.4285714]` is not decoration and is not a guess: before this batch
 *  the `<table>` carried shadcn's `text-sm`, whose paired line-height is
 *  `calc(1.25 / 0.875)`. `.table td { font-size: 12.5px }` overrode the size but
 *  not the leading, so every descendant computed its line box from that number
 *  rather than from the root's `1.5`. Replacing `text-sm` with `text-[12.5px]`
 *  drops the pairing, and each table row grows 2px. Measured against the
 *  pre-change baseline: row pitch 64px before, 66px without this. */
function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-auto">
      <table
        data-slot="table"
        className={cn("w-full caption-bottom border-collapse text-[12.5px] leading-[1.4285714]", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn(
        // `.table tbody tr:hover` was tbody-scoped, so the hover belongs here and
        // not on TableRow — TableHeader renders a TableRow too, and header rows
        // never took the row-hover background.
        "[&_tr:last-child]:border-0 [&_tr:last-child>td]:border-b-0 [&_tr]:hover:bg-[color:var(--row-hover)]",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "transition-colors data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-auto whitespace-nowrap border-b border-[color:var(--border-soft)] px-[14px] py-[10px] text-left align-middle text-[12px] font-normal text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "whitespace-nowrap border-b border-[color:var(--border-soft)] px-[14px] py-[13px] align-middle text-[12.5px] text-secondary-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
}
