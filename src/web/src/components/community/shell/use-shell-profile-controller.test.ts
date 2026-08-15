import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useShellProfileController } from "./use-shell-profile-controller"

const mocks = vi.hoisted(() => ({
  currentUser: {
    id: "self",
    name: "Self",
    avatar: "S",
    aboutMe: "About",
    statusEmoji: "🙂",
    statusText: "Here",
  },
  setCurrentUser: vi.fn(),
  fetchQuery: vi.fn(),
  createDm: vi.fn(),
  acceptDm: vi.fn(),
  updateProfile: vi.fn(),
  uploadAvatar: vi.fn(),
  setUserStatus: vi.fn(),
  communityReset: vi.fn(),
  wsReset: vi.fn(),
  streamReset: vi.fn(),
  clearCache: vi.fn(),
  signOut: vi.fn(),
  toast: vi.fn(),
  toastApiError: vi.fn(),
  validate: vi.fn(),
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
  useSetCurrentUser: () => mocks.setCurrentUser,
}))
vi.mock("@/stores/community", () => ({
  useCommunityStore: Object.assign(vi.fn(), {
    getState: () => ({ reset: mocks.communityReset }),
  }),
}))
vi.mock("@/stores/community/ws", () => ({
  useOnlineUserIds: () => new Set(["self", "remote"]),
  useCommunityWsStore: Object.assign(vi.fn(), {
    getState: () => ({ setUserStatus: mocks.setUserStatus, reset: mocks.wsReset }),
  }),
}))
vi.mock("@/stores/community/message-stream", () => ({
  useMessageStreamStore: Object.assign(vi.fn(), {
    getState: () => ({ resetAll: mocks.streamReset }),
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
  }),
}))
vi.mock("@/lib/community/presence", () => ({ resolveProfilePresence: () => "online" }))
vi.mock("@/lib/community/avatar", () => ({ avatarInitial: () => "?" }))
vi.mock("@/lib/query-persister", () => ({ clearPersistedCache: mocks.clearCache }))
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
  const queryClient = { fetchQuery: mocks.fetchQuery, clear: vi.fn() }
  let current!: Result
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(Capture, {
      options: {
        router,
        queryClient,
        cancelPendingNavigation,
        view: "server",
        activeServerId: "s1",
      } as never,
      onResult: (result) => { current = result },
    }))
  })
  return { get current() { return current }, renderer, router, pushed, cancelPendingNavigation, queryClient }
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
    mocks.updateProfile.mockResolvedValue({})
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
    expect(hook.current.profile?.initialStatusEmoji).toBeNull()
    expect(mocks.fetchQuery).not.toHaveBeenCalled()
  })

  it("opens a remote seed before fetch and hydrates only card state", async () => {
    const response = deferred<{
      aboutMe: string
      mutualServers: number
      discriminator: string
      statusEmoji: string | null
      statusText: string | null
    }>()
    mocks.fetchQuery.mockReturnValue(response.promise)
    const hook = await renderController()
    await act(async () => hook.current.openProfile("Remote", { clientX: 4, clientY: 5 } as never, undefined, "remote"))
    expect(hook.current.profile?.data.about).toBe("seed")
    expect(mocks.fetchQuery).toHaveBeenCalledWith(expect.objectContaining({
      staleTime: 300_000,
    }))

    await act(async () => response.resolve({
      aboutMe: "hydrated",
      mutualServers: 3,
      discriminator: "1234",
      statusEmoji: "🌱",
      statusText: "Growing",
    }))
    expect(hook.current.profile?.data).toMatchObject({
      about: "hydrated",
      mutual: 3,
      discriminator: "1234",
    })
    expect(hook.current.profile?.initialStatusEmoji).toBe("🌱")
    expect(mocks.setUserStatus).not.toHaveBeenCalled()
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

  it("writes own status and UserSettings saves to current-user and WS state after mutation", async () => {
    const order: string[] = []
    mocks.updateProfile.mockImplementation(async () => { order.push("mutate") })
    mocks.setCurrentUser.mockImplementation(() => { order.push("current-user") })
    mocks.setUserStatus.mockImplementation(() => { order.push("ws") })
    const hook = await renderController()

    await act(async () => hook.current.updateOwnStatus("🌱", "Growing"))
    expect(order).toEqual(["mutate", "current-user", "ws"])
    expect(mocks.updateProfile).toHaveBeenLastCalledWith({
      statusEmoji: "🌱",
      statusText: "Growing",
    })
    const statusUpdater = mocks.setCurrentUser.mock.calls.at(-1)![0]
    expect(statusUpdater(mocks.currentUser)).toMatchObject({
      statusEmoji: "🌱",
      statusText: "Growing",
    })
    expect(mocks.setUserStatus).toHaveBeenLastCalledWith("self", "🌱", "Growing")

    order.length = 0
    await act(async () => hook.current.userSettingsProps.onSave({
      name: "Renamed",
      aboutMe: "Updated",
      statusEmoji: "🚀",
      statusText: "Shipping",
    }))
    expect(order).toEqual(["mutate", "current-user", "ws"])
    const settingsUpdater = mocks.setCurrentUser.mock.calls.at(-1)![0]
    expect(settingsUpdater(mocks.currentUser)).toMatchObject({
      name: "Renamed",
      aboutMe: "Updated",
      statusEmoji: "🚀",
      statusText: "Shipping",
    })
    expect(mocks.setUserStatus).toHaveBeenLastCalledWith("self", "🚀", "Shipping")

    mocks.setUserStatus.mockClear()
    await act(async () => hook.current.userSettingsProps.onSave({ aboutMe: "About only" }))
    expect(mocks.setUserStatus).not.toHaveBeenCalled()

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
    hook.queryClient.clear.mockImplementation(() => { order.push("query") })
    mocks.clearCache.mockImplementation(async () => { order.push("cache"); throw new Error("cache") })
    mocks.signOut.mockImplementation(async () => { order.push("signOut") })
    hook.router.push = (href: string) => { order.push(`push:${href}`) }
    await act(async () => hook.current.userSettingsProps.onLogout())
    expect(order).toEqual(["cancel", "community", "ws", "stream", "query", "cache", "signOut", "push:/sign-in"])

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

    vi.spyOn(Date, "now").mockReturnValue(123)
    const uploadOptions = mocks.uploadAvatar.mock.calls[0]![1]
    await act(async () => uploadOptions.onSuccess({ url: "/avatar.png" }))
    const avatarUpdater = mocks.setCurrentUser.mock.calls.at(-1)![0]
    expect(avatarUpdater(mocks.currentUser).avatar).toBe("/avatar.png?t=123")
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
