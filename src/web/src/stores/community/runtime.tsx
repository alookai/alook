"use client"

import { createStoreContext } from "@tanstack/react-store"
import type { CommunityRuntime } from "./runtime-owner"
export type { CommunityRuntime } from "./runtime-owner"
export { getCommunityRuntime, readCurrentCommunityChannelMeta } from "./runtime-owner"

const { StoreProvider, useStoreContext } = createStoreContext<{ runtime: CommunityRuntime }>()
export const CommunityRuntimeProvider = StoreProvider
export const useCommunityRuntime = () => useStoreContext().runtime
