"use client"

import { LazyMotion, domMin, useAnimation } from "motion/react"
import { useLucideContext, type LucideProps } from "lucide-react"
import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { useReducedMotion } from "@/hooks/use-reduced-motion"

type CompatibleIconProps = Omit<LucideProps, "absoluteStrokeWidth"> & { absoluteStrokeWidth?: boolean }
type AnimatedIconProps = CompatibleIconProps & { duration?: number; isAnimated?: boolean }
type Artwork = (controls: ReturnType<typeof useAnimation>, duration: number) => ReactNode

export function createAnimatedIcon(names: string[], useArtwork: Artwork) {
  const AnimatedIcon = forwardRef<SVGSVGElement, AnimatedIconProps>(function AnimatedIcon(
    { size: ownSize, color: ownColor, strokeWidth: ownStrokeWidth, absoluteStrokeWidth: ownAbsoluteStrokeWidth, nonScalingStroke: ownNonScalingStroke, className, width: ownWidth, height: ownHeight, children, duration = 1, isAnimated = true, ...props },
    ref,
  ) {
    const context: CompatibleIconProps | undefined = useLucideContext()
    const size = ownSize ?? context?.size ?? 24
    const width = ownWidth ?? size
    const height = ownHeight ?? size
    const color = ownColor ?? context?.color ?? "currentColor"
    const strokeWidth = ownStrokeWidth ?? context?.strokeWidth ?? 2
    const absoluteStrokeWidth = ownAbsoluteStrokeWidth ?? context?.absoluteStrokeWidth ?? false
    const nonScalingStroke = ownNonScalingStroke ?? context?.nonScalingStroke ?? false
    const controls = useAnimation()
    const reduced = useReducedMotion()
    const svg = useRef<SVGSVGElement>(null)
    useImperativeHandle(ref, () => svg.current!, [])

    useEffect(() => {
      const element = svg.current
      if (!element) return
      const control = element.closest("button,a[href],[role='button'],[role='menuitem'],[role='menuitemcheckbox'],[role='menuitemradio'],[role='option']")
      let target: Element = control ?? element
      while (!control && getComputedStyle(target).pointerEvents === "none" && target.parentElement) target = target.parentElement
      const enter = () => {
        if (!isAnimated || reduced || element.closest(":disabled,[aria-disabled='true'],[data-disabled]:not([data-disabled='false']),[inert]")) return
        void controls.start("animate")
      }
      const leave = () => { void controls.start("normal") }
      target.addEventListener("mouseenter", enter)
      target.addEventListener("mouseleave", leave)
      return () => {
        target.removeEventListener("mouseenter", enter)
        target.removeEventListener("mouseleave", leave)
      }
    }, [controls, isAnimated, reduced, className])

    const accessible = Boolean(children) || Object.keys(props).some((key) => key.startsWith("aria-") || key === "role" || key === "title")
    return (
      <LazyMotion features={domMin} strict>
        <svg
          ref={svg}
          xmlns="http://www.w3.org/2000/svg"
          width={width}
          height={height}
          viewBox="0 0 24 24"
          fill="none"
          stroke={color}
          strokeWidth={absoluteStrokeWidth ? Number(strokeWidth) * 24 / Number(width) : strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden={accessible ? undefined : true}
          className={cn("lucide", names.map((name) => `lucide-${name}`), context?.className, nonScalingStroke && "**:[vector-effect:non-scaling-stroke]", className)}
          {...props}
        >
          {useArtwork(controls, duration)}
          {children}
        </svg>
      </LazyMotion>
    )
  })
  AnimatedIcon.displayName = `${names[0]}Icon`
  return AnimatedIcon
}
