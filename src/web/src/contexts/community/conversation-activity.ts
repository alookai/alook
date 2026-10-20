"use client"

import { createContext, useContext } from "react"

export const ConversationActivityContext = createContext(true)

export function useConversationActivity() {
  return useContext(ConversationActivityContext)
}
