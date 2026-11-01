import { afterEach, expect, it, vi } from "vitest"
import { createCommunityWsStore } from "@/stores/community/ws-store"
import { channelRefAccessQualification, channelRefTargetAffected } from "./channel-ref"

afterEach(() => vi.restoreAllMocks())
const target = { server: { id: "server", name: "Studio" }, channel: { id: "child", name: "Thread", parentChannelId: "parent" } }

it("shares unknown scope sorting and does not enumerate scopes for a known target", () => {
  const ws = createCommunityWsStore("viewer")
  for (let i = 0; i < 1000; i++) ws.actions.beginChannelMembershipChange("other", `other-${i}`)
  const state = ws.get(), iterate = vi.spyOn(state.channelAccessScopes, Symbol.iterator)
  const known = channelRefAccessQualification(state, target)
  for (let i = 0; i < 100; i++) expect(channelRefAccessQualification(state, target)).toBe(known)
  expect(iterate).not.toHaveBeenCalled()
  const unknown = channelRefAccessQualification(state)
  for (let i = 0; i < 100; i++) expect(channelRefAccessQualification(state)).toBe(unknown)
  expect(iterate).toHaveBeenCalledTimes(1)
})

it("uses target, parent and server generations and resets them with the account owner", () => {
  const ws = createCommunityWsStore("viewer")
  const known = channelRefAccessQualification(ws.get(), target), unknown = channelRefAccessQualification(ws.get())
  ws.actions.revokeServerAccess("other")
  expect(channelRefAccessQualification(ws.get(), target)).toBe(known)
  expect(channelRefAccessQualification(ws.get())).not.toBe(unknown)
  ws.actions.revokeChannelAccess("server", "parent")
  expect(channelRefAccessQualification(ws.get(), target)).not.toBe(known)
  ws.actions.rememberChannelAccess("server", "child", "parent")
  const restored = channelRefAccessQualification(ws.get(), target)
  ws.actions.revokeServerAccess("server")
  expect(channelRefAccessQualification(ws.get(), target)).not.toBe(restored)
  ws.actions.grantServerAccess("server")
  expect(channelRefAccessQualification(ws.get(), target)).not.toBe(restored)
  ws.actions.activateProfileAccount("other-viewer")
  expect(ws.get().serverAccessGenerations.size).toBe(0)
  expect(channelRefAccessQualification(ws.get(), target)).not.toBe(known)
})

it("limits known invalidation to the actual scope and keeps unknown targets conservative", () => {
  expect(channelRefTargetAffected(target, { channelId: "other" })).toBe(false)
  expect(channelRefTargetAffected(target, { channelId: "parent" })).toBe(true)
  expect(channelRefTargetAffected(target, { channelId: "child" })).toBe(true)
  expect(channelRefTargetAffected(target, { serverId: "other" })).toBe(false)
  expect(channelRefTargetAffected(target, { serverId: "server" })).toBe(true)
  expect(channelRefTargetAffected(undefined, { channelId: "other" })).toBe(true)
  expect(channelRefTargetAffected(target)).toBe(true)
})
