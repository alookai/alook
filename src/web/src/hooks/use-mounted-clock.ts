"use client"

import { useState } from "react"
import { createAtom, useAtom } from "@tanstack/react-store"

export function useMountedClock() {
  const [clock] = useState(() => createAtom(Date.now()))
  return useAtom(clock)
}
