import { createElement, type PropsWithChildren } from "react"
import { beforeEach, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { useMachines } from "./use-machines"
import { useCreateOrGetDm } from "./mutations/dm"
import { useResolveOrCreateInvite } from "./mutations/invites"
import { useMarkMessage, useUnmarkMessage } from "./mutations/message-memberships"
import { useUploadUserAvatar } from "./mutations/profile"
import { useJoinServer } from "./mutations/servers"
import { useSetBotNotificationSetting } from "./use-notification-settings"
import { communityKeys } from "@/lib/query-keys"
import { configureTelemetry, retireTelemetry } from "@/lib/observability/telemetry"

const api = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => api(...args), toastApiError: vi.fn() }))
beforeEach(() => { api.mockReset() })
it("projects the native machines query and retains its original cache values", async () => {
  const { client, registry } = await createCommunityQueryOwner()
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client, registry }, children)
  configureTelemetry({ session_id: "machines-session" }, true)
  try {
    const rendered = renderHook(() => useMachines({ enabled: false }), { wrapper })
    expect(rendered.result.current.machines).toEqual([])
    const data = { machines: [{ id: "machine-a", hostname: "host" }] }
    act(() => client.setQueryData(communityKeys.machines(), data))
    await waitFor(() => expect(rendered.result.current.machines).toBe(data.machines))
    expect(api).not.toHaveBeenCalled()
    rendered.unmount()
  } finally { retireTelemetry() }
})
it("preserves exact native mutation actions and original scoped requests for consumer commands", async () => {
  const { client, registry } = await createCommunityQueryOwner()
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client, registry }, children)
  api.mockImplementation(async (path: string, options?: RequestInit) => path.endsWith("/invites") ? options?.method === "POST" ? { invite: { token: "invite-a", uses: 0, maxUses: null, expiresAt: null } } : { invites: [] } : path.endsWith("/avatar") ? { url: "/avatar.png", avatarVersion: 2 } : path.endsWith("/join") ? { serverId: "server-a" } : { conversation: { id: "dm-a" } })
  const rendered = renderHook(() => ({ dm: useCreateOrGetDm(), invite: useResolveOrCreateInvite("server-a"), mark: useMarkMessage(), unmark: useUnmarkMessage(), avatar: useUploadUserAvatar(), join: useJoinServer(), notification: useSetBotNotificationSetting() }), { wrapper })
  const assert = Object.assign(vi.fn(), { signal: new AbortController().signal })
  await act(async () => {
    expect(await rendered.result.current.dm.mutateAsync({ userId: "peer-a" })).toEqual({ conversation: { id: "dm-a" } })
    expect(await rendered.result.current.invite.mutateAsync({ currentUserId: "viewer", assert })).toMatchObject({ token: "invite-a" })
    await rendered.result.current.mark.mutateAsync({ messageId: "message-a", channelId: "channel-a" })
    await rendered.result.current.unmark.mutateAsync({ messageId: "message-a" })
    expect(await rendered.result.current.avatar.mutateAsync({ file: new File(["avatar"], "avatar.png") })).toMatchObject({ avatarVersion: 2 })
    await rendered.result.current.join.mutateAsync({ inviteCode: "invite-a" })
    await rendered.result.current.notification.mutateAsync({ botId: "bot-a", scope: { kind: "channel", id: "channel-a" }, level: "mentions" })
  })
  expect(client.getMutationCache().getAll().map(mutation => mutation.options.meta?.observabilityAction).sort()).toEqual(["bot.notification.update", "dm.open", "message.mark", "message.unmark", "profile.avatar.upload", "server.invite.resolve", "server.join"])
  expect(api.mock.calls.every(([, options]) => options.authenticationAccount === "viewer" && typeof options.assertActive === "function")).toBe(true)
  expect(api).toHaveBeenCalledWith("/api/community/messages/message-a/marks", expect.objectContaining({ method: "PUT", body: JSON.stringify({ channelId: "channel-a" }) }))
  expect(api).toHaveBeenCalledWith("/api/community/bots/bot-a/notifications/channel/channel-a", expect.objectContaining({ method: "PUT", body: JSON.stringify({ level: "mentions" }) }))
  rendered.unmount()
})
