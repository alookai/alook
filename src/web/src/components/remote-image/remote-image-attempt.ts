"use client"

import {
  useCallback,
  useLayoutEffect,
  useRef,
  type RefCallback,
  type SyntheticEvent,
} from "react"
import { useCreateStore, useSelector } from "@tanstack/react-store"

export type RemoteImageStatus = "pending" | "ready" | "error"

type AttemptState = {
  attempt: number
  status: RemoteImageStatus
  image?: HTMLImageElement
  source?: string
}

type AttemptAction =
  | { type: "ready"; attempt: number; image: HTMLImageElement; source?: string }
  | { type: "error"; attempt: number; source?: string }
  | { type: "retry" }
  | { type: "source"; source?: string }

function reduceAttempt(state: AttemptState, action: AttemptAction, identity: boolean): AttemptState {
  if (action.type === "source" && action.source === state.source) return state
  if (action.type === "retry" || action.type === "source") {
    return {
      attempt: state.attempt + 1,
      status: "pending",
      source: action.type === "source" ? action.source : state.source,
      image: identity ? state.image : undefined,
    }
  }
  if (state.attempt !== action.attempt || state.source !== action.source || state.status !== "pending") return state
  return action.type === "ready"
    ? { attempt: state.attempt, source: state.source, status: "ready", image: action.image }
    : { attempt: state.attempt, source: state.source, status: "error" }
}

export function useRemoteImageAttempt({ source, cachedReady = false }: { source?: string; cachedReady?: boolean } = {}) {
  const identity = source !== undefined
  const store = useCreateStore({ attempt: 0, status: "pending", source, active: true, generation: 0 } as AttemptState & { active: boolean; generation: number })
  const node = useRef<HTMLImageElement | null>(null)
  const state = useSelector(store, (value) => value)
  const dispatch = useCallback((action: AttemptAction, generation = store.get().generation) => store.setState((current) => {
    if (!current.active || current.generation !== generation) return current
    const next = reduceAttempt(current, action, identity)
    return next === current ? current : { ...next, active: current.active, generation: current.generation }
  }), [identity, store])
  useLayoutEffect(() => {
    store.setState((current) => ({ ...current, active: true }))
    return () => store.setState((current) => ({ ...current, active: false, generation: current.generation + 1 }))
  }, [store])
  useLayoutEffect(() => { dispatch({ type: "source", source }) }, [dispatch, source])
  const matchesSource = useCallback((image: HTMLImageElement) => source === undefined || (
    image.getAttribute("src") === source
    && (!image.currentSrc || image.currentSrc === image.src)
  ), [source])
  const decode = useCallback(async (image: HTMLImageElement, attempt: number) => {
    if (!matchesSource(image) || store.get().source !== source) return
    const generation = store.get().generation
    try {
      await image.decode?.()
    } catch {
      if (matchesSource(image)) dispatch({ type: "error", attempt, source }, generation)
      return
    }
    if (!matchesSource(image)) return
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      dispatch({ type: "error", attempt, source }, generation)
      return
    }
    dispatch({ type: "ready", attempt, image, source }, generation)
  }, [store, dispatch, matchesSource, source])

  const imageRef = useCallback<RefCallback<HTMLImageElement>>((image) => {
    node.current = image
    if (!image?.complete || !matchesSource(image) || store.get().source !== source) return
    if (store.get().status === "ready") return
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      dispatch({ type: "error", attempt: state.attempt, source })
      return
    }
    if (cachedReady) dispatch({ type: "ready", attempt: state.attempt, image, source })
    else void decode(image, state.attempt)
  }, [cachedReady, decode, dispatch, matchesSource, source, state.attempt, store])

  const onLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    void decode(event.currentTarget, state.attempt)
  }, [decode, state.attempt])

  const onImageError = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    if (matchesSource(event.currentTarget)) dispatch({ type: "error", attempt: state.attempt, source })
  }, [dispatch, matchesSource, source, state.attempt])

  const retry = useCallback(() => {
    dispatch({ type: "retry" })
    const image = node.current
    if (source !== undefined && image?.getAttribute("src") === source) image.src = source
  }, [dispatch, source])

  return [
    state.source === source ? state.status : "pending",
    state.attempt,
    state.image,
    imageRef,
    onLoad,
    onImageError,
    retry,
  ] as const
}
