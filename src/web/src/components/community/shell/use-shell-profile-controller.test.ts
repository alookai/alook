import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useShellProfileController } from "./use-shell-profile-controller"

const mocks = vi.hoisted(() => ({
  currentUser: {
    id: "self",
    name: "Self",
    avatar: "S",
    avatarVersion: 0,
    aboutMe: "About",
    statusEmoji: "🙂",
    statusText: "Here",
  },
  fetchQuery: vi.fn(),
  createDm: vi.fn(),
  acceptDm: vi.fn(),
  updateProfile: vi.fn(),
  uploadAvatar: vi.fn(),
  beginProfileSnapshot: vi.fn(),
  commitProfiles: vi.fn(),
  patchProfiles: vi.fn(),
  communityReset: vi.fn(),
  wsReset: vi.fn(),
  streamReset: vi.fn(),
  clearCache: vi.fn(),
  signOut: vi.fn(),
  toast: vi.fn(),
  toastApiError: vi.fn(),
  validate: vi.fn(),
  disposeReconciliation: vi.fn(),
}))

vi.mock("sonner", () => ({ toast: mocks.toast }))
vi.mock("@/lib/api/client", () => ({ toastApiError: mocks.toastApiError }))
vi.mock("@/hooks/community/use-user-profile", () => ({
  userProfileQueryFn: (id: string) => () => Promise.resolve({ id }),
  PROFILE_STALE_TIME_MS: 300_000,
}))
vi.mock("@/lib/community/image-crop", () => ({ validateIconSourceFile: mocks.validate }))
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => mocks.currentUser,
}))
vi.mock("@/stores/community", () => ({
  useCommunityStore: Object.assign(vi.fn(), {
    getState: () => ({ reset: mocks.communityReset }),
  }),
}))
vi.mock("@/stores/community/ws", () => ({
  useCommunityWsStore: Object.assign(vi.fn(), {
    getState: () => ({
      reset: mocks.wsReset,
      beginProfileSnapshot: mocks.beginProfileSnapshot,
      commitProfiles: mocks.commitProfiles,
      patchProfiles: mocks.patchProfiles,
    }),
  }),
}))
vi.mock("@/stores/community/message-stream", () => ({
  useMessageStreamStore: Object.assign(vi.fn(), {
    getState: () => ({
      resetAll: mocks.streamReset,
    }),
  }),
}))
vi.mock("@/hooks/community/use-friends", () => ({
  useFriends: () => ({ friends: [{ id: "remote", userId: "remote", name: "Remote", avatar: "R", sub: "seed" }] }),
}))
vi.mock("@/hooks/community/use-server-members", () => ({
  useServerMembers: () => ({ members: [{ id: "remote", userId: "remote", name: "Remote", avatar: "R", sub: "seed" }] }),
}))
vi.mock("@/hooks/community/mutations", () => ({
  useCreateOrGetDm: () => ({ mutateAsync: mocks.createDm }),
  useUpdateProfile: () => ({ mutateAsync: mocks.updateProfile }),
  useUploadUserAvatar: () => ({ mutate: mocks.uploadAvatar }),
}))
vi.mock("@/hooks/community/use-dm-message-sender", () => ({
  useDmMessageSender: () => ({ accept: mocks.acceptDm }),
}))
vi.mock("@/components/community/social/profile-lookup", () => ({
  resolveProfileServerId: (_view: string, id?: string) => id,
  resolveProfileContextLabel: () => "Server member",
  resolveProfileTarget: (members: Array<{ userId: string; name: string }>, _friends: unknown, target: { name: string; userId?: string }) =>
    members.find((member) => member.userId === target.userId || member.name === target.name),
  resolveProfileUserId: (member?: { userId: string }, target?: string) => member?.userId ?? target,
  buildSelfProfile: (user: { id: string; name: string; avatar: string }) => ({
    name: user.name,
    userId: user.id,
    avatar: user.avatar,
    about: "About",
    mutual: 0,
    presence: "online",
    identity: { kind: "human" },
  }),
}))
vi.mock("@/lib/query-persister", () => ({ clearPersistedCache: mocks.clearCache }))
vi.mock("@/hooks/community/community-ws/read-state-reconciliation", () => ({
  disposeAccountReadStateReconciliation: mocks.disposeReconciliation,
}))
vi.mock("@/lib/auth-client", () => ({ signOut: mocks.signOut }))

type Result = ReturnType<typeof useShellProfileController>

function Capture({ options, onResult }: {
  options: Parameters<typeof useShellProfileController>[0]
  onResult: (result: Result) => void
}) {
  onResult(useShellProfileController(options))
  return null
}

async function renderController() {
  const pushed: string[] = []
  const router = {
    push: (href: string) => { pushed.push(href) },
    replace: vi.fn(),
    prefetch: vi.fn(),
  }
  const cancelPendingNavigation = vi.fn()
  const queryClient = { fetchQuery: mocks.fetchQuery, clear: vi.fn(), setQueriesData: vi.fn() }
  let current!: Result
  let renderer!: TestRenderer.ReactTestRenderer
  const render = () => createElement(Capture, {
    options: {
      router,
      queryClient,
      cancelPendingNavigation,
      view: "server",
      activeServerId: "s1",
    } as never,
    onResult: (result) => { current = result },
  })
  await act(async () => {
    renderer = TestRenderer.create(render())
  })
  return {
    get current() { return current },
    renderer,
    router,
    pushed,
    cancelPendingNavigation,
    queryClient,
    rerender: async () => act(async () => renderer.update(render())),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe("useShellProfileController", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (typeof mock === "function" && "mockReset" in mock) mock.mockReset()
    }
    mocks.validate.mockReturnValue({ ok: true })
    mocks.updateProfile.mockResolvedValue({
      id: "self",
      name: "Self",
      discriminator: "0001",
      avatar: "S",
      avatarVersion: 0,
      aboutMe: "About",
      bannerColor: null,
      statusEmoji: "🙂",
      statusText: "Here",
    })
    mocks.beginProfileSnapshot.mockReturnValue({ viewerId: "self", accountEpoch: 1, revision: 0 })
    mocks.clearCache.mockResolvedValue(undefined)
    mocks.signOut.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("opens self synchronously only for the exact target id", async () => {
    const hook = await renderController()
    await act(async () => hook.current.openProfile("Self", { clientX: 2, clientY: 3 } as never, undefined, "self"))
    expect(hook.current.profile?.data.userId).toBe("self")
    expect(hook.current.profile?.x).toBe(2)
    expect(mocks.fetchQuery).not.toHaveBeenCalled()
  })

  it("does not infer self from matching name or discriminator", async () => {
    const hook = await renderController()
    await act(async () => hook.current.openProfile(
      "Self",
      { clientX: 6, clientY: 7 } as never,
      "0001",
    ))

    expect(hook.current.profile?.data.name).toBe("Self")
    expect(hook.current.profile?.data.userId).toBeUndefined()
    expect(mocks.fetchQuery).not.toHaveBeenCalled()
  })

  it("opens a remote seed before fetch and hydrates only card state", async () => {
    const response = deferred<{
      id: string
      aboutMe: string
      mutualServers: number
      discriminator: string
      statusEmoji: string | null
      statusText: string | null
      kind: "human"
    }>()
    mocks.fetchQuery.mockReturnValue(response.promise)
    const hook = await renderController()
    await act(async () => hook.current.openProfile("Remote", { clientX: 4, clientY: 5 } as never, undefined, "remote"))
    expect(hook.current.profile?.data).toMatchObject({
      userId: "remote",
      contextLabel: "Server member",
    })
    expect(mocks.fetchQuery).toHaveBeenCalledWith(expect.objectContaining({
      staleTime: 300_000,
    }))

    await act(async () => response.resolve({
      id: "remote",
      aboutMe: "hydrated",
      mutualServers: 3,
      discriminator: "1234",
      statusEmoji: "🌱",
      statusText: "Growing",
      kind: "human",
    }))
    expect(hook.current.profile?.data).toMatchObject({
      mutual: 3,
      identity: { kind: "human" },
    })
  })

  it("keeps identity fields out of controller state after an authoritative profile fetch", async () => {
    mocks.fetchQuery.mockResolvedValue({
      id: "remote",
      aboutMe: "hydrated",
      mutualServers: 1,
      discriminator: "1234",
      image: null,
      avatarVersion: 4,
      statusEmoji: null,
      statusText: "",
      kind: "human",
    })
    const hook = await renderController()

    await act(async () => hook.current.openProfile(
      "Remote",
      { clientX: 4, clientY: 5 } as never,
      undefined,
      "remote",
    ))

    expect(hook.current.profile?.data).toMatchObject({
      userId: "remote",
      mutual: 1,
      identity: { kind: "human" },
    })
    expect(hook.current.profile?.data).not.toHaveProperty("avatar")
    expect(hook.current.profile?.data).not.toHaveProperty("name")
  })

  it("keeps open-card state limited to target and context metadata", async () => {
    mocks.fetchQuery.mockReturnValue(new Promise(() => {}))
    const hook = await renderController()
    await act(async () => hook.current.openProfile(
      "Remote",
      { clientX: 4, clientY: 5 } as never,
      undefined,
      "remote",
    ))
    expect(hook.current.profile?.data).toMatchObject({
      userId: "remote",
      contextLabel: "Server member",
    })
    expect(hook.current.profile?.data).not.toHaveProperty("avatar")
  })

  it("does not let a slow profile response overwrite the next opened card", async () => {
    const first = deferred<Record<string, unknown>>()
    const second = deferred<Record<string, unknown>>()
    mocks.fetchQuery
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const hook = await renderController()

    await act(async () => hook.current.openProfile(
      "Remote",
      { clientX: 4, clientY: 5 } as never,
      undefined,
      "remote",
    ))
    await act(async () => hook.current.openProfile(
      "Next",
      { clientX: 8, clientY: 9 } as never,
      undefined,
      "next",
    ))
    await act(async () => second.resolve({
      id: "next",
      aboutMe: "next hydrated",
      mutualServers: 1,
      discriminator: "9001",
      statusEmoji: null,
      statusText: "",
      kind: "human",
    }))
    await act(async () => first.resolve({
      id: "remote",
      aboutMe: "stale response",
      mutualServers: 9,
      discriminator: "0001",
      statusEmoji: "❌",
      statusText: "stale",
      kind: "human",
    }))

    expect(hook.current.profile?.data).toMatchObject({
      userId: "next",
      mutual: 1,
      identity: { kind: "human" },
    })
  })

  it("hydrates bot ownership, swaps to the exact owner, and routes audit preview", async () => {
    mocks.fetchQuery.mockResolvedValueOnce({
      id: "remote",
      aboutMe: "bot",
      mutualServers: 0,
      discriminator: "1234",
      statusEmoji: null,
      statusText: "",
      kind: "bot",
      ownerProfile: { id: "owner", handle: "Owner#0042" },
      ownedByViewer: true,
    }).mockResolvedValueOnce({
      id: "owner",
      aboutMe: "owner",
      mutualServers: 0,
      discriminator: "0042",
      statusEmoji: null,
      statusText: "",
      kind: "human",
    })
    const hook = await renderController()

    await act(async () => hook.current.openProfile(
      "Remote",
      { clientX: 4, clientY: 5 } as never,
      undefined,
      "remote",
    ))
    expect(hook.current.profile?.data.identity).toEqual({
      kind: "bot",
      ownerProfile: { id: "owner", handle: "Owner#0042" },
      ownedByViewer: true,
    })

    await act(async () => hook.current.openOwnerProfile({ id: "owner", handle: "Owner#0042" }))
    expect(hook.current.profile).toMatchObject({
      x: 4,
      y: 5,
      data: { userId: "owner" },
    })

    act(() => hook.current.openBotAudit("remote"))
    expect(hook.cancelPendingNavigation).toHaveBeenCalledOnce()
    expect(hook.pushed).toContain("/c/me/bots?audit=remote")
    expect(hook.current.profile).toBeNull()
  })

  it("opens empty-text DMs, does not await accepted commits, and blocks rejected sends", async () => {
    mocks.createDm.mockResolvedValue({ conversation: { id: "dm1" } })
    const hook = await renderController()
    await act(async () => hook.current.profileMessage("remote", "   "))
    expect(mocks.acceptDm).not.toHaveBeenCalled()
    expect(hook.pushed).toEqual(["/c/me/dm1"])

    hook.pushed.length = 0
    mocks.acceptDm.mockReturnValue({ accepted: false })
    await act(async () => hook.current.profileMessage("remote", "hello"))
    expect(mocks.toast).toHaveBeenLastCalledWith("Failed to send message")
    expect(hook.pushed).toEqual([])

    const never = new Promise<void>(() => {})
    mocks.acceptDm.mockReturnValue({ accepted: true, committed: never })
    await act(async () => hook.current.profileMessage("remote", "hello"))
    expect(hook.pushed).toEqual(["/c/me/dm1"])
  })

  it("seeds canonical mutation responses through the captured request snapshot", async () => {
    const hook = await renderController()

    await act(async () => hook.current.updateOwnStatus("🌱", "Growing"))
    expect(mocks.updateProfile).toHaveBeenLastCalledWith({
      statusEmoji: "🌱",
      statusText: "Growing",
    })
    expect(mocks.commitProfiles).toHaveBeenCalledWith(
      { viewerId: "self", accountEpoch: 1, revision: 0 },
      [expect.objectContaining({ id: "self" })],
    )

    await act(async () => hook.current.userSettingsProps.onSave({
      name: "Renamed",
      aboutMe: "Updated",
      statusEmoji: "🚀",
      statusText: "Shipping",
    }))
    expect(mocks.commitProfiles).toHaveBeenCalledTimes(2)
    await act(async () => hook.current.userSettingsProps.onSave({ aboutMe: "About only" }))
    expect(mocks.commitProfiles).toHaveBeenCalledTimes(3)

    const statusError = new Error("status")
    mocks.updateProfile.mockRejectedValueOnce(statusError)
    await act(async () => hook.current.updateOwnStatus(null, null))
    expect(mocks.toastApiError).toHaveBeenLastCalledWith(statusError, "Failed to update status")

    const saveError = new Error("save")
    mocks.updateProfile.mockRejectedValueOnce(saveError)
    await act(async () => hook.current.userSettingsProps.onSave({ name: "Broken" }))
    expect(mocks.toastApiError).toHaveBeenLastCalledWith(saveError, "Failed to save profile")
  })

  it("preserves logout ordering and rejection behavior", async () => {
    const order: string[] = []
    const hook = await renderController()
    hook.cancelPendingNavigation.mockImplementation(() => { order.push("cancel") })
    mocks.communityReset.mockImplementation(() => { order.push("community") })
    mocks.wsReset.mockImplementation(() => { order.push("ws") })
    mocks.streamReset.mockImplementation(() => { order.push("stream") })
    mocks.disposeReconciliation.mockImplementation(() => { order.push("reconcile") })
    hook.queryClient.clear.mockImplementation(() => { order.push("query") })
    mocks.clearCache.mockImplementation(async () => { order.push("cache"); throw new Error("cache") })
    mocks.signOut.mockImplementation(async () => { order.push("signOut") })
    hook.router.push = (href: string) => { order.push(`push:${href}`) }
    await act(async () => hook.current.userSettingsProps.onLogout())
    expect(order).toEqual(["cancel", "community", "ws", "stream", "reconcile", "query", "cache", "signOut", "push:/sign-in"])

    order.length = 0
    mocks.clearCache.mockResolvedValue(undefined)
    mocks.signOut.mockRejectedValue(new Error("auth"))
    await expect(act(async () => hook.current.userSettingsProps.onLogout())).rejects.toThrow("auth")
    expect(order.some((entry) => entry.startsWith("push:"))).toBe(false)
  })

  it("starts avatar upload before revoking exactly once", async () => {
    const order: string[] = []
    let input: { files?: File[]; onchange?: () => void; click: () => void } | undefined
    vi.stubGlobal("document", {
      createElement: () => {
        input = { click: vi.fn() }
        return input
      },
    })
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:avatar"),
      revokeObjectURL: vi.fn(() => { order.push("revoke") }),
    })
    mocks.uploadAvatar.mockImplementation(() => { order.push("upload") })
    const hook = await renderController()
    await act(async () => hook.current.userSettingsProps.onUploadAvatar())
    input!.files = [new File(["image"], "avatar.png", { type: "image/png" })]
    await act(async () => input!.onchange?.())
    expect(hook.current.pendingAvatarCrop?.imageSrc).toBe("blob:avatar")
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    await act(async () => hook.current.pendingAvatarCrop?.onCropped(
      new File(["crop"], "avatar.png", { type: "image/png" }),
    ))
    expect(order).toEqual(["upload", "revoke"])
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(hook.current.pendingAvatarCrop).toBeNull()

    const uploadOptions = mocks.uploadAvatar.mock.calls[0]![1]
    await act(async () => uploadOptions.onSuccess({ url: "/avatar.png?v=4", avatarVersion: 4 }))
    expect(mocks.patchProfiles).toHaveBeenCalledWith(
      { viewerId: "self", accountEpoch: 1, revision: 0 },
      [{
        id: "self",
        avatar: { avatar: "/avatar.png?v=4", avatarVersion: 4 },
      }],
    )
    expect(mocks.toast).toHaveBeenLastCalledWith("Avatar updated")

    const uploadError = new Error("upload")
    uploadOptions.onError(uploadError)
    expect(mocks.toastApiError).toHaveBeenLastCalledWith(
      uploadError,
      "Failed to upload avatar",
    )
  })

  it("rejects invalid avatar files before object URL creation", async () => {
    let input: { files?: File[]; onchange?: () => void; click: () => void } | undefined
    const createObjectURL = vi.fn(() => "blob:invalid")
    vi.stubGlobal("document", {
      createElement: () => {
        input = { click: vi.fn() }
        return input
      },
    })
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() })
    mocks.validate.mockReturnValue({ ok: false, error: "Choose a smaller image" })
    const hook = await renderController()

    await act(async () => hook.current.userSettingsProps.onUploadAvatar())
    input!.files = [new File(["large"], "large.png", { type: "image/png" })]
    await act(async () => input!.onchange?.())
    expect(mocks.toast).toHaveBeenLastCalledWith("Choose a smaller image")
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(hook.current.pendingAvatarCrop).toBeNull()
  })

  it("cancels avatar crop with one revoke and no upload", async () => {
    let input: { files?: File[]; onchange?: () => void; click: () => void } | undefined
    const revokeObjectURL = vi.fn()
    vi.stubGlobal("document", {
      createElement: () => {
        input = { click: vi.fn() }
        return input
      },
    })
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:cancel"),
      revokeObjectURL,
    })
    const hook = await renderController()

    await act(async () => hook.current.userSettingsProps.onUploadAvatar())
    input!.files = [new File(["image"], "avatar.png", { type: "image/png" })]
    await act(async () => input!.onchange?.())
    await act(async () => hook.current.pendingAvatarCrop?.onCancel())

    expect(mocks.uploadAvatar).not.toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:cancel")
    expect(hook.current.pendingAvatarCrop).toBeNull()
  })
})
