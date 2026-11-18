import type { InfiniteData, QueryKey } from "@tanstack/react-query"
import type { MessagesWindowPage, MessagesPageParam } from "./models/message"

export type InitialMessageWindow = Extract<MessagesPageParam, { mode: "newest" | "anchor" | "since" }>
export type MessageWindowData = InfiniteData<MessagesWindowPage, MessagesPageParam>

export function messageWindowIdentity(key: QueryKey): { channelId: string; initial: InitialMessageWindow; tag: string | null } | undefined {
  if (key[0] !== "community" || key[1] !== "channel" || typeof key[2] !== "string" || !key[2] || key[3] !== "messages") return
  if (key.length === 4) return { channelId: key[2], initial: { mode: "newest" }, tag: null }
  if (key.length !== 6 || key[4] !== "window" || !key[5] || typeof key[5] !== "object") return
  const value = key[5] as Record<string, unknown>
  if (value.tag !== null && typeof value.tag !== "string") return
  const tag = value.tag as string | null
  if (value.mode === "newest" && Object.keys(value).length === 2) return { channelId: key[2], initial: { mode: "newest" }, tag }
  if (value.mode === "anchor" && typeof value.anchor === "string" && value.anchor.length > 0 && Object.keys(value).length === 3) return { channelId: key[2], initial: { mode: "anchor", anchor: value.anchor }, tag }
  if (value.mode === "since" && typeof value.since === "string" && value.since.length > 0 && Object.keys(value).length === 3) return { channelId: key[2], initial: { mode: "since", since: value.since }, tag }
}
