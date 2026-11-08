"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useEffect } from "react"

export function useReducedMotion() {
  const [reduced, setReduced] = useAtom(useCreateAtom(false))
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const sync = () => setReduced(query.matches)
    sync()
    query.addEventListener("change", sync)
    return () => query.removeEventListener("change", sync)
  }, [setReduced])
  return reduced
}
