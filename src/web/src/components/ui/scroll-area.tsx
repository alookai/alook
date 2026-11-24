"use client"

import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"
import { cn } from "@/lib/utils"

function ScrollAreaRoot({
  className,
  ...props
}: ScrollAreaPrimitive.Root.Props) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    />
  )
}

function ScrollAreaViewport({
  className,
  style,
  ref,
  ...props
}: ScrollAreaPrimitive.Viewport.Props & { ref?: React.Ref<HTMLDivElement> }) {
  const attachViewport = React.useCallback(
    (node: HTMLDivElement | null) => {
      if (node && typeof node.getAnimations !== "function") {
        node.getAnimations = () => []
      }
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [ref],
  )
  return (
    <ScrollAreaPrimitive.Viewport
      ref={attachViewport}
      data-slot="scroll-area-viewport"
      className={cn("size-full rounded-[inherit] scrollbar-none", className)}
      style={{ overflow: undefined, ...style }}
      {...props}
    />
  )
}

function ScrollAreaContent({
  className,
  style,
  ...props
}: ScrollAreaPrimitive.Content.Props) {
  return (
    <ScrollAreaPrimitive.Content
      data-slot="scroll-area-content"
      className={cn("min-w-0", className)}
      style={{ minWidth: undefined, ...style }}
      {...props}
    />
  )
}

function ScrollBar({
  className,
  thumbClassName,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props & { thumbClassName?: string }) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "pointer-events-none z-20 flex touch-none select-none p-0.5 opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none data-hovering:pointer-events-auto data-hovering:opacity-100 data-scrolling:pointer-events-auto data-scrolling:opacity-100",
        orientation === "vertical" && "w-2.5 flex-col",
        orientation === "horizontal" && "h-2.5 flex-row",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className={cn(
          "shrink-0 rounded-full bg-foreground/20 transition-colors duration-150 ease-out hover:bg-foreground/35 active:bg-foreground/45 motion-reduce:transition-none",
          orientation === "vertical" ? "w-full" : "h-full",
          thumbClassName,
        )}
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

function ScrollArea({
  className,
  viewportClassName,
  contentClassName,
  viewportRef,
  viewportProps,
  orientation = "vertical",
  children,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  viewportClassName?: string
  contentClassName?: string
  viewportRef?: React.Ref<HTMLDivElement>
  viewportProps?: Omit<ScrollAreaPrimitive.Viewport.Props, "className" | "children"> & {
    [key: `data-${string}`]: string | number | boolean | undefined
  }
  orientation?: "vertical" | "horizontal" | "both"
}) {
  const axisClass =
    orientation === "vertical"
      ? "overflow-x-clip overflow-y-auto"
      : orientation === "horizontal"
        ? "overflow-x-auto overflow-y-clip"
        : "overflow-auto"

  return (
    <ScrollAreaRoot className={className} {...props}>
      <ScrollAreaViewport
        ref={viewportRef}
        className={cn(axisClass, viewportClassName)}
        {...viewportProps}
      >
        <ScrollAreaContent className={contentClassName}>
          {children}
        </ScrollAreaContent>
      </ScrollAreaViewport>
      {(orientation === "vertical" || orientation === "both") && (
        <ScrollBar orientation="vertical" />
      )}
      {(orientation === "horizontal" || orientation === "both") && (
        <ScrollBar orientation="horizontal" />
      )}
    </ScrollAreaRoot>
  )
}

export { ScrollArea, ScrollAreaContent, ScrollAreaRoot, ScrollAreaViewport, ScrollBar }
