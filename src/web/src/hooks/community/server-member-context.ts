"use client"

import { createContext, createElement, useMemo, type ReactNode } from "react"
import { displayName, UNAVAILABLE_MEMBER } from "@/lib/community/display-name"
import { useServerMembers } from "./use-server-members"

type SharedServerMemberState = {
  serverId: string
  currentUserId: string
  membersHook: ReturnType<typeof useServerMembers>
  resolveUserName: (userId: string) => string
}

export const ServerMemberContext = createContext<SharedServerMemberState | null>(null)

export function useMemoizedMemberNameResolver(members: ReadonlyArray<{ userId?: string; id?: string; name?: string }>) {
  let memberNameKey = ""
  for (const { userId, id, name } of members) {
    memberNameKey += `${userId ?? ""}\0${id ?? ""}\0${name ?? ""}\x01`
  }
  return useMemo(() => {
    const namesById = new Map<string, string>()
    if (memberNameKey) {
      for (const entry of memberNameKey.split("\x01")) {
        if (!entry) continue
        const first = entry.indexOf("\0")
        const second = entry.indexOf("\0", first + 1)
        if (first < 0 || second < 0) continue
        const userId = entry.slice(0, first)
        const id = entry.slice(first + 1, second)
        const name = entry.slice(second + 1)
        const key = userId || id
        if (key && !namesById.has(key)) namesById.set(key, displayName({ name }))
      }
    }
    return (userId: string) => namesById.get(userId) ?? UNAVAILABLE_MEMBER
  }, [memberNameKey])
}

export function ServerMemberProvider({
  serverId,
  currentUserId,
  enabled,
  children,
}: {
  serverId: string
  currentUserId: string
  enabled: boolean
  children: ReactNode
}) {
  const membersHook = useServerMembers(enabled ? serverId : null)
  const resolveUserName = useMemoizedMemberNameResolver(membersHook.members)
  const value = useMemo<SharedServerMemberState | null>(
    () => (enabled ? { serverId, currentUserId, membersHook, resolveUserName } : null),
    [currentUserId, enabled, membersHook, resolveUserName, serverId],
  )
  return createElement(ServerMemberContext.Provider, { value }, children)
}
