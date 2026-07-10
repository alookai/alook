"use client"

import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"

function Slider<Value extends number | readonly number[]>({
  className,
  ...props
}: SliderPrimitive.Root.Props<Value>) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn("relative flex w-full touch-none items-center select-none", className)}
      {...props}
    />
  )
}

function SliderControl({ className, ...props }: SliderPrimitive.Control.Props) {
  return (
    <SliderPrimitive.Control
      data-slot="slider-control"
      className={cn("relative flex w-full items-center py-2", className)}
      {...props}
    />
  )
}

function SliderTrack({ className, ...props }: SliderPrimitive.Track.Props) {
  return (
    <SliderPrimitive.Track
      data-slot="slider-track"
      className={cn(
        "relative h-1.5 w-full grow rounded-full bg-muted",
        className
      )}
      {...props}
    />
  )
}

function SliderRange({ className, ...props }: SliderPrimitive.Indicator.Props) {
  return (
    <SliderPrimitive.Indicator
      data-slot="slider-range"
      className={cn("absolute h-full rounded-full bg-primary", className)}
      {...props}
    />
  )
}

function SliderThumb({ className, ...props }: SliderPrimitive.Thumb.Props) {
  return (
    <SliderPrimitive.Thumb
      data-slot="slider-thumb"
      className={cn(
        "block size-4 shrink-0 rounded-full border border-primary bg-background shadow-sm outline-none transition-[color,box-shadow] focus-visible:ring-4 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Slider, SliderControl, SliderTrack, SliderRange, SliderThumb }
