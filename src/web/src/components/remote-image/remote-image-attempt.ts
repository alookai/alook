"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  type RefCallback,
  type SyntheticEvent,
} from "react"
import { createStore, useSelector, useAtom, useCreateAtom } from "@tanstack/react-store"

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
  const store = useMemo(() => createStore({ attempt: 0, status: "pending", active: true, generation: 0 } as AttemptState & { active: boolean; generation: number }), [])
  const state = useSelector(store, (value) => value)
  const dispatch = useCallback((action: AttemptAction, generation = store.get().generation) => store.setState((current) => {
    if (!current.active || current.generation !== generation) return current
    const next = reduceAttempt(current, action)
    return next === current ? current : { ...next, active: current.active, generation: current.generation }
  }), [store])
  useLayoutEffect(() => {
    store.setState((current) => ({ ...current, active: true }))
    return () => store.setState((current) => ({ ...current, active: false, generation: current.generation + 1 }))
  }, [store])
  const decode = useCallback(async (image: HTMLImageElement, attempt: number) => {
    const generation = store.get().generation
    try {
      await image.decode?.()
    } catch {
      dispatch({ type: "error", attempt }, generation)
      return
    }
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      dispatch({ type: "error", attempt }, generation)
      return
    }
    dispatch({ type: "ready", attempt, image }, generation)
  }, [store, dispatch])

  const imageRef = useCallback<RefCallback<HTMLImageElement>>((image) => {
    if (!image?.complete) return
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      dispatch({ type: "error", attempt: state.attempt })
      return
    }
    void decode(image, state.attempt)
  }, [decode, dispatch, state.attempt])

  const onLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    void decode(event.currentTarget, state.attempt)
  }, [decode, state.attempt])

  const onImageError = useCallback(() => {
    dispatch({ type: "error", attempt: state.attempt })
  }, [dispatch, state.attempt])

  const retry = useCallback(() => dispatch({ type: "retry" }), [dispatch])

  useEffect(() => {
    if (!eligible || state.status !== "pending") return
    const attempt = state.attempt
    const timeout = setTimeout(() => dispatch({ type: "error", attempt }), timeoutMs)
    return () => clearTimeout(timeout)
  }, [dispatch, eligible, state.attempt, state.status, timeoutMs])

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
  const [element, setElement] = useAtom(useCreateAtom<HTMLElement | null>(null))
  const [eligible, setEligible] = useAtom(useCreateAtom(!lazy))
  const ref = useCallback((next: HTMLElement | null) => setElement(next), [setElement])

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
  }, [element, eligible, lazy, setEligible])

  return [eligible, ref] as const
}
