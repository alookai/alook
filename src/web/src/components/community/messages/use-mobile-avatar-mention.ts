"use client"

import { useCallback, useEffect, useRef } from "react"
import type React from "react"
import { movedBeyondLongPressTolerance } from "./mobile-message-gesture"

const AVATAR_MENTION_LONG_PRESS_MS = 500

export function useMobileAvatarMention({
  onMention,
  onProfileClick,
}: {
  onMention?: () => void
  onProfileClick: (event: React.MouseEvent<HTMLButtonElement>) => void
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const suppressClickRef = useRef(false)

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    startRef.current = null
  }, [])
  const cancelAndSuppressClick = useCallback(() => {
    clear()
    suppressClickRef.current = true
  }, [clear])

  useEffect(() => clear, [clear])

  return {
    onPointerDown: onMention
      ? (event: React.PointerEvent<HTMLButtonElement>) => {
          if (event.pointerType !== "touch") return
          clear()
          suppressClickRef.current = false
          startRef.current = { x: event.clientX, y: event.clientY }
          timerRef.current = setTimeout(() => {
            timerRef.current = null
            suppressClickRef.current = true
            navigator.vibrate?.(10)
            onMention()
          }, AVATAR_MENTION_LONG_PRESS_MS)
        }
      : undefined,
    onPointerMove: onMention
      ? (event: React.PointerEvent<HTMLButtonElement>) => {
          if (event.pointerType !== "touch") return
          const start = startRef.current
          if (start && movedBeyondLongPressTolerance(
            start.x,
            start.y,
            event.clientX,
            event.clientY,
          )) cancelAndSuppressClick()
        }
      : undefined,
    onPointerUp: onMention
      ? (event: React.PointerEvent<HTMLButtonElement>) => {
          if (event.pointerType === "touch") clear()
        }
      : undefined,
    onPointerCancel: onMention
      ? (event: React.PointerEvent<HTMLButtonElement>) => {
          if (event.pointerType === "touch") cancelAndSuppressClick()
        }
      : undefined,
    onContextMenu: onMention
      ? (event: React.MouseEvent<HTMLButtonElement>) => {
          if (suppressClickRef.current) event.preventDefault()
        }
      : undefined,
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false
        event.preventDefault()
        event.stopPropagation()
        return
      }
      onProfileClick(event)
    },
  }
}
