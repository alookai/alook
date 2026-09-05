"use client"

import {
  useCallback,
  useEffect,
  useReducer,
  useState,
  type RefCallback,
  type SyntheticEvent,
} from "react"

export const REMOTE_IMAGE_TIMEOUT_MS = 5_000

export type RemoteImageStatus = "pending" | "ready" | "error"

type AttemptState = {
  attempt: number
  status: RemoteImageStatus
  image?: HTMLImageElement
}

type AttemptAction =
  | { type: "ready"; attempt: number; image: HTMLImageElement }
  | { type: "error"; attempt: number }
  | { type: "retry" }

function reduceAttempt(state: AttemptState, action: AttemptAction): AttemptState {
  if (action.type === "retry") {
    return { attempt: state.attempt + 1, status: "pending" }
  }
  if (state.attempt !== action.attempt || state.status !== "pending") return state
  return action.type === "ready"
    ? { attempt: state.attempt, status: "ready", image: action.image }
    : { attempt: state.attempt, status: "error" }
}

type RemoteImageAttemptOptions = {
  eligible?: boolean
  timeoutMs?: number
}

export function useRemoteImageAttempt({
  eligible = true,
  timeoutMs = REMOTE_IMAGE_TIMEOUT_MS,
}: RemoteImageAttemptOptions = {}) {
  const [state, dispatch] = useReducer(reduceAttempt, {
    attempt: 0,
    status: "pending",
  })
  const decode = useCallback(async (image: HTMLImageElement, attempt: number) => {
    try {
      await image.decode?.()
    } catch {
      dispatch({ type: "error", attempt })
      return
    }
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      dispatch({ type: "error", attempt })
      return
    }
    dispatch({ type: "ready", attempt, image })
  }, [])

  const imageRef = useCallback<RefCallback<HTMLImageElement>>((image) => {
    if (!image?.complete) return
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      dispatch({ type: "error", attempt: state.attempt })
      return
    }
    void decode(image, state.attempt)
  }, [decode, state.attempt])

  const onLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    void decode(event.currentTarget, state.attempt)
  }, [decode, state.attempt])

  const onImageError = useCallback(() => {
    dispatch({ type: "error", attempt: state.attempt })
  }, [state.attempt])

  const retry = useCallback(() => dispatch({ type: "retry" }), [])

  useEffect(() => {
    if (!eligible || state.status !== "pending") return
    const attempt = state.attempt
    const timeout = setTimeout(() => dispatch({ type: "error", attempt }), timeoutMs)
    return () => clearTimeout(timeout)
  }, [eligible, state.attempt, state.status, timeoutMs])

  return [
    state.status,
    state.attempt,
    state.image,
    imageRef,
    onLoad,
    onImageError,
    retry,
  ] as const
}

export function useRemoteImageEligibility(lazy: boolean) {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [eligible, setEligible] = useState(!lazy)
  const ref = useCallback((next: HTMLElement | null) => setElement(next), [])

  useEffect(() => {
    if (!lazy) {
      setEligible(true)
      return
    }
    if (!element || eligible) return
    if (typeof IntersectionObserver === "undefined") {
      setEligible(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setEligible(true)
      observer.disconnect()
    }, { rootMargin: "300px" })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, eligible, lazy])

  return [eligible, ref] as const
}
