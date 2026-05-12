"use client"

import * as React from "react"
import { Select as SelectPrimitive } from "@base-ui/react/select"
import { cn } from "@/lib/utils"
import { ChevronDownIcon, CheckIcon } from "lucide-react"

function Select({
  modal = false,
  ...props
}: SelectPrimitive.Root.Props<string>) {
  return <SelectPrimitive.Root data-slot="select" modal={modal} {...props} />
}

function SelectTrigger({
  className,
  children,
  hideIcon = false,
  ...props
}: SelectPrimitive.Trigger.Props & { hideIcon?: boolean }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "flex h-8 w-full items-center justify-between gap-2 overflow-hidden rounded-lg border border-input bg-transparent px-3 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-placeholder:text-muted-foreground [&>*:first-child]:truncate",
        className
      )}
      {...props}
    >
      {children}
      {!hideIcon && (
        <SelectPrimitive.Icon className="shrink-0">
          <ChevronDownIcon className="size-3.5 opacity-50" />
        </SelectPrimitive.Icon>
      )}
    </SelectPrimitive.Trigger>
  )
}

function SelectValue({ ...props }: SelectPrimitive.Value.Props) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

function SelectPortal({ ...props }: SelectPrimitive.Portal.Props) {
  return <SelectPrimitive.Portal data-slot="select-portal" {...props} />
}

function SelectPopup({
  className,
  children,
  portal = true,
  alignItemWithTrigger,
  side,
  align,
  sideOffset,
  ...props
}: SelectPrimitive.Popup.Props & { portal?: boolean; alignItemWithTrigger?: boolean; side?: "top" | "bottom" | "left" | "right"; align?: "start" | "center" | "end"; sideOffset?: number }) {
  const content = (
    <SelectPrimitive.Positioner alignItemWithTrigger={alignItemWithTrigger} side={side} align={align} sideOffset={sideOffset}>
      <SelectPrimitive.Popup
        data-slot="select-popup"
        className={cn(
          "z-50 min-w-(--anchor-width) overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-md outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
      </SelectPrimitive.Popup>
    </SelectPrimitive.Positioner>
  )

  if (!portal) {
    return content
  }

  return <SelectPortal>{content}</SelectPortal>
}

function SelectItem({
  className,
  children,
  ...props
}: SelectPrimitive.Item.Props & { className?: string }) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default select-none items-center rounded-md py-1.5 pl-2 pr-8 text-sm outline-none transition-colors data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2">
        <CheckIcon className="size-3.5" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

function SelectGroup({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("", className)}
      {...props}
    />
  )
}

function SelectGroupLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.GroupLabel>) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-group-label"
      className={cn(
        "px-2 py-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wider",
        className
      )}
      {...props}
    />
  )
}

export {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
  SelectGroup,
  SelectGroupLabel,
}
