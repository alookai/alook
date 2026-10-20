"use client"

import { createContext } from "react"

export type MobilePageBack = (target: string) => boolean
export const MobilePageBackContext = createContext<{
  register: (request: MobilePageBack) => () => void
} | null>(null)
