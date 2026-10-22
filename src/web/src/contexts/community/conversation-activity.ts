"use client"

import { createContext, useContext } from "react"

export const ConversationActivityContext = createContext(true)
export const ConversationPresentationContext = createContext<boolean | null>(null)

export function useConversationActivity() {
  return useContext(ConversationActivityContext)
}
