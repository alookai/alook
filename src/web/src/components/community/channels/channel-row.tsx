import type React from "react"
import type { EntityKind } from "@/lib/community/models/navigation"
import { EntityIcon } from "../entity-icon"

export function ChannelRow({ name, kind, wrapName, className, children, ...props }: React.ComponentPropsWithRef<"div"> & {
  name: string
  kind?: EntityKind
  wrapName?: boolean
}) {
  return (
    <div {...props} className={`group relative flex w-full items-center gap-2 rounded-md px-2 text-sm ${className ?? ""}`}>
      <span className="grid size-5 shrink-0 place-items-center opacity-70"><EntityIcon kind={kind} className="size-4" /></span>
      <span title={name} className={`min-w-0 font-semibold ${wrapName ? "flex-1 wrap-anywhere" : "truncate"}`}>{name}</span>
      {children}
    </div>
  )
}
