"use client"

import { useLayoutEffect, useRef, useState } from "react"

export type AuditPreviewPlacement = "right" | "left" | "top" | "bottom"

type RectLike = Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width" | "height">

export function resolveAuditPreviewPlacement({
  card,
  preview,
  viewportWidth,
  viewportHeight,
  gap = 8,
}: {
  card: RectLike
  preview: Pick<RectLike, "width" | "height">
  viewportWidth: number
  viewportHeight: number
  gap?: number
}): AuditPreviewPlacement {
  const room = {
    right: viewportWidth - card.right,
    left: card.left,
    top: card.top,
    bottom: viewportHeight - card.bottom,
  }
  const sideCrossAxisFits = preview.height <= viewportHeight - gap * 2
  const verticalCrossAxisFits = preview.width <= viewportWidth - gap * 2

  if (sideCrossAxisFits && room.right >= preview.width + gap) return "right"
  if (sideCrossAxisFits && room.left >= preview.width + gap) return "left"
  if (verticalCrossAxisFits && room.top >= preview.height + gap) return "top"
  if (verticalCrossAxisFits && room.bottom >= preview.height + gap) return "bottom"

  return (Object.entries(room) as Array<[AuditPreviewPlacement, number]>)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "right"
}

type AuditPreviewPosition = {
  placement: AuditPreviewPlacement
  left: number | string
  top: number
  height?: number
}

type MeasuredAuditPreviewPosition = AuditPreviewPosition & {
  measurementKey: string
}

function clamp(value: number, min: number, max: number): number {
  if (min > max) return value
  return Math.min(Math.max(value, min), max)
}

export function useProfileSecondaryPosition(
  enabled: boolean,
  previewId: string | undefined,
  x: number,
  y: number,
) {
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const [measuredPosition, setMeasuredPosition] = useState<MeasuredAuditPreviewPosition | null>(null)
  const measurementKey = enabled && previewId ? `${previewId}:${x}:${y}` : null

  useLayoutEffect(() => {
    if (!measurementKey) {
      setMeasuredPosition(null)
      return
    }

    let frame = 0
    const update = () => {
      const cardElement = cardRef.current
      const previewElement = previewRef.current
      if (!cardElement || !previewElement) return
      const transformedCard = cardElement.getBoundingClientRect()
      const card = {
        top: transformedCard.top,
        right: transformedCard.left + cardElement.offsetWidth,
        bottom: transformedCard.top + cardElement.offsetHeight,
        left: transformedCard.left,
        width: cardElement.offsetWidth,
        height: cardElement.offsetHeight,
      }
      const preview = {
        width: previewElement.offsetWidth,
        height: previewElement.offsetHeight,
      }
      const gap = 8
      const margin = 8
      const placement = resolveAuditPreviewPlacement({
        card,
        preview,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        gap,
      })

      const verticalOffset = clamp(
        0,
        margin - card.top,
        window.innerHeight - margin - preview.height - card.top,
      )
      const horizontalOffset = clamp(
        card.width - preview.width,
        margin - card.left,
        window.innerWidth - margin - preview.width - card.left,
      )
      const next: MeasuredAuditPreviewPosition = placement === "right"
        ? { measurementKey, placement, left: card.width + gap, top: verticalOffset, height: card.height }
        : placement === "left"
          ? { measurementKey, placement, left: -preview.width - gap, top: verticalOffset, height: card.height }
          : placement === "top"
            ? { measurementKey, placement, left: horizontalOffset, top: -preview.height - gap, height: card.height }
            : { measurementKey, placement, left: horizontalOffset, top: card.height + gap, height: card.height }

      setMeasuredPosition((current) => current?.measurementKey === next.measurementKey
        && current.placement === next.placement
        && current.left === next.left
        && current.top === next.top
        && current.height === next.height
        ? current
        : next)
    }

    update()
    frame = requestAnimationFrame(update)
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    const popoverElement = popoverRef.current
    popoverElement?.addEventListener("animationend", update)
    popoverElement?.addEventListener("animationcancel", update)
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update)
    if (cardRef.current) observer?.observe(cardRef.current)
    if (previewRef.current) observer?.observe(previewRef.current)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
      popoverElement?.removeEventListener("animationend", update)
      popoverElement?.removeEventListener("animationcancel", update)
      observer?.disconnect()
    }
  }, [measurementKey])

  const ready = measurementKey !== null
    && measuredPosition?.measurementKey === measurementKey
  return {
    popoverRef,
    cardRef,
    previewRef,
    position: ready ? measuredPosition : null,
    ready,
  }
}
