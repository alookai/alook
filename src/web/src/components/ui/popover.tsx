"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  children,
  side,
  sideOffset = 6,
  align = "start",
  ...props
}: PopoverPrimitive.Popup.Props & {
  side?: "top" | "bottom" | "left" | "right" | "inline-end" | "inline-start"
  sideOffset?: number
  align?: "start" | "center" | "end"
}) {
  // Always portal to document.body so popovers escape parent portals
  // (e.g. Sheet/Dialog). Without this, base-ui's FloatingPortal falls back to
  // the nearest parentPortalNode, which inherits the Sheet's width constraint
  // and causes the popover to render inline inside the Sheet.
  const container =
    typeof document !== "undefined" ? document.body : null
  return (
    <PopoverPrimitive.Portal container={container}>
      <PopoverPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        style={{ zIndex: 60 }}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "w-72 origin-(--transform-origin) rounded-lg border bg-popover p-2 text-popover-foreground shadow-md outline-none",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
