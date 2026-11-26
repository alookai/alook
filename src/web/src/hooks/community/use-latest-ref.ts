"use client"

import { useLayoutEffect, useRef, type RefObject } from "react"

export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  }, [value])
  return ref
}
