"use client"

import { createContext, useContext } from "react"

export const CommunityPreviewNavigation = createContext(false)
export const useCommunityPreviewNavigation = () => useContext(CommunityPreviewNavigation)
