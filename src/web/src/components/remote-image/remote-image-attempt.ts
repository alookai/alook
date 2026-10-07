"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefCallback,
  type SyntheticEvent,
} from "react"
import { createStore, useSelector, useAtom, useCreateAtom } from "@tanstack/react-store"
import { observeImage, type ImageSlot } from "@/lib/observability/images"
import { telemetryGeneration } from "@/lib/observability/telemetry"

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
  slot?: ImageSlot
}

export function useRemoteImageAttempt({
  eligible = true,
  timeoutMs = REMOTE_IMAGE_TIMEOUT_MS,
  slot = "content",
}: RemoteImageAttemptOptions = {}) {
  const store = useMemo(() => createStore({ attempt: 0, status: "pending", active: true, generation: 0 } as AttemptState & { active: boolean; generation: number }), [])
  const state = useSelector(store, (value) => value)
  const currentImage = useRef<HTMLImageElement | null>(null)
  const record = useCallback((phase: Parameters<typeof observeImage>[2], image = currentImage.current, fields: Parameters<typeof observeImage>[4] = {}) => {
    const current = store.get()
    observeImage(store, slot, phase, image, { attempt: current.attempt, image_generation: current.generation, image_state: current.status, current_node: !!image && currentImage.current === image, ...fields })
  }, [store, slot])
  const dispatch = useCallback((action: AttemptAction, generation = store.get().generation, observationGeneration = telemetryGeneration()) => {
    const before = store.get()
    store.setState((current) => {
      if (!current.active || current.generation !== generation) return current
      const next = reduceAttempt(current, action)
      return next === current ? current : { ...next, active: current.active, generation: current.generation }
    })
    const after = store.get()
    const reason = !before.active ? "inactive" : before.generation !== generation ? "generation" : action.type !== "retry" && before.attempt !== action.attempt ? "attempt" : after === before ? "terminal" : undefined
    if (observationGeneration === telemetryGeneration()) record(reason ? "ignored" : "state", action.type === "ready" ? action.image : currentImage.current, { previous_state: before.status, ignored_reason: reason, outcome: reason ? "rejected" : "observed", attempt: action.type === "retry" ? after.attempt : action.attempt, image_generation: generation })
  }, [store, record])
  useLayoutEffect(() => {
    store.setState((current) => ({ ...current, active: true }))
    record("effect_setup")
    return () => {
      record("effect_cleanup")
      store.setState((current) => ({ ...current, active: false, generation: current.generation + 1 }))
    }
  }, [store, record])
  const decode = useCallback(async (image: HTMLImageElement, attempt: number) => {
    const generation = store.get().generation
    const observationGeneration = telemetryGeneration()
    let decodeCalled = false
    try {
      const decoder = image.decode
      decodeCalled = typeof decoder === "function"
      record(decodeCalled ? "decode_start" : "decode_unavailable", image, { attempt, image_generation: generation, decode_called: decodeCalled })
      await decoder?.call(image)
    } catch {
      if (observationGeneration === telemetryGeneration()) record("decode_error", image, { attempt, image_generation: generation, outcome: "error", image_failure: "decode_rejected", decode_called: decodeCalled })
      dispatch({ type: "error", attempt }, generation, observationGeneration)
      return
    }
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      if (observationGeneration === telemetryGeneration()) record("error", image, { attempt, image_generation: generation, outcome: "empty", image_failure: "no_pixels", decode_called: decodeCalled })
      dispatch({ type: "error", attempt }, generation, observationGeneration)
      return
    }
    if (observationGeneration === telemetryGeneration()) record(decodeCalled ? "decode_ready" : "pixels_ready", image, { attempt, image_generation: generation, outcome: "success", decode_called: decodeCalled })
    dispatch({ type: "ready", attempt, image }, generation, observationGeneration)
  }, [store, dispatch, record])

  const imageRef = useCallback<RefCallback<HTMLImageElement>>((image) => {
    if (currentImage.current && currentImage.current !== image) record("detach", currentImage.current)
    currentImage.current = image
    if (image) record("attach", image)
    if (!image?.complete) return
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      dispatch({ type: "error", attempt: state.attempt })
      return
    }
    void decode(image, state.attempt)
  }, [decode, dispatch, record, state.attempt])

  const onLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    record("load", event.currentTarget)
    void decode(event.currentTarget, state.attempt)
  }, [decode, record, state.attempt])

  const onImageError = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    record("error", event.currentTarget, { outcome: "error", image_failure: "load_error" })
    dispatch({ type: "error", attempt: state.attempt })
  }, [dispatch, record, state.attempt])

  const retry = useCallback(() => { record("retry"); dispatch({ type: "retry" }) }, [dispatch, record])

  useEffect(() => {
    record("eligible", undefined, { eligible })
    if (!eligible || state.status !== "pending") return
    const attempt = state.attempt
    record("timer_start", undefined, { timeout_ms: timeoutMs })
    const timeout = setTimeout(() => { record("timeout", undefined, { attempt, timeout_ms: timeoutMs, outcome: "timeout" }); dispatch({ type: "error", attempt }) }, timeoutMs)
    return () => { clearTimeout(timeout); record("timer_clear", undefined, { attempt }) }
  }, [dispatch, record, eligible, state.attempt, state.status, timeoutMs])

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
