import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ resource: vi.fn(), channels: vi.fn(), communicate: vi.fn() }))
vi.mock("@alook/shared", () => ({ queries: { communityPage: { getReadableResource: (...args: unknown[]) => mocks.resource(...args), listReadablePageChannels: (...args: unknown[]) => mocks.channels(...args) } } }))
vi.mock("./permissions", () => ({ requireMessageSurfaceCommunicationAccess: (...args: unknown[]) => mocks.communicate(...args) }))
import { pageAccessRole } from "./page-access.server"
beforeEach(() => { vi.clearAllMocks(); mocks.resource.mockResolvedValue({ botId: "publisher" }); mocks.channels.mockResolvedValue([{ channelId: "read-only-dm" }, { channelId: "editable-channel" }]); mocks.communicate.mockImplementation(async (_db, id) => ({ ok: id === "editable-channel" })) })
it("uses any readable linked conversation for editor access, including a later editable source", async () => {
  expect(await pageAccessRole({} as never, "artifact", "reader")).toBe("editor")
  expect(mocks.communicate.mock.calls.map(call => call[1])).toEqual(["read-only-dm", "editable-channel"])
  mocks.channels.mockResolvedValue([{ channelId: "read-only-dm" }])
  expect(await pageAccessRole({} as never, "artifact", "reader")).toBe("viewer")
  mocks.resource.mockResolvedValue(null)
  expect(await pageAccessRole({} as never, "artifact", "reader")).toBeNull()
})
it("keeps an independent upload available to its publisher before any message links exist", async () => {
  expect(await pageAccessRole({} as never, "artifact", "publisher")).toBe("editor")
  expect(mocks.channels).not.toHaveBeenCalled()
})
