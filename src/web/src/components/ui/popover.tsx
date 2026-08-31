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

function PopoverPortal({ container, ...props }: PopoverPrimitive.Portal.Props) {
  const resolvedContainer = container
    ?? (typeof document !== "undefined" ? document.body : null)
  return (
    <PopoverPrimitive.Portal
      data-slot="popover-portal"
      container={resolvedContainer}
      {...props}
    />
  )
}

function PopoverBackdrop({
  className,
  ...props
}: PopoverPrimitive.Backdrop.Props) {
  return (
    <PopoverPrimitive.Backdrop
      data-slot="popover-backdrop"
      className={cn(
        "fixed z-50 bg-black/20 backdrop-blur-[2px] transition-[opacity,backdrop-filter] duration-200 ease-out data-ending-style:opacity-0 data-ending-style:backdrop-blur-none data-starting-style:opacity-0 data-starting-style:backdrop-blur-none",
        className,
      )}
      {...props}
    />
  )
}

function PopoverPositioner({
  style,
  ...props
}: PopoverPrimitive.Positioner.Props) {
  return (
    <PopoverPrimitive.Positioner
      data-slot="popover-positioner"
      style={{ zIndex: 60, ...style }}
      {...props}
    />
  )
}

function PopoverPopup({
  className,
  ...props
}: PopoverPrimitive.Popup.Props) {
  return (
    <PopoverPrimitive.Popup
      data-slot="popover-content"
      className={cn(
        "rounded-lg border bg-popover text-popover-foreground shadow-md outline-none",
        "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
        "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
        className,
      )}
      {...props}
    />
  )
}

function PopoverClose({ ...props }: PopoverPrimitive.Close.Props) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />
}

function PopoverTitle({
  className,
  ...props
}: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cn("font-heading font-semibold", className)}
      {...props}
    />
  )
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

export {
  Popover,
  PopoverBackdrop,
  PopoverClose,
  PopoverContent,
  PopoverPopup,
  PopoverPortal,
  PopoverPositioner,
  PopoverTitle,
  PopoverTrigger,
}
