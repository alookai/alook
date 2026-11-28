import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ resource: vi.fn(), channels: vi.fn(), context: vi.fn(), communicate: vi.fn() }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityPage: {
        getReadableResource: (...args: unknown[]) => mocks.resource(...args),
        listReadablePageChannels: (...args: unknown[]) => mocks.channels(...args),
        getPageAccessContext: (...args: unknown[]) => mocks.context(...args),
      },
    },
  }
})
vi.mock("./permissions", () => ({ requireMessageSurfaceCommunicationAccess: (...args: unknown[]) => mocks.communicate(...args) }))
import { pageAccessRole } from "./page-access.server"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resource.mockResolvedValue({ botId: "publisher" })
  mocks.channels.mockResolvedValue([{ channelId: "read-only-dm", channelType: "dm" }, { channelId: "editable-dm", channelType: "dm" }])
  mocks.context.mockImplementation(async () => ({
    page: await mocks.resource(),
    channels: await mocks.channels(),
  }))
  mocks.communicate.mockImplementation(async (_db, id) => ({ ok: id === "editable-dm" }))
})

it("uses any readable linked conversation for editor access, including a later editable DM source", async () => {
  expect(await pageAccessRole({} as never, "artifact", "reader")).toBe("editor")
  expect(mocks.communicate.mock.calls.map(call => call[1])).toEqual(["read-only-dm", "editable-dm"])
  mocks.channels.mockResolvedValue([{ channelId: "read-only-dm", channelType: "dm" }])
  expect(await pageAccessRole({} as never, "artifact", "reader")).toBe("viewer")
  mocks.resource.mockResolvedValue(null)
  expect(await pageAccessRole({} as never, "artifact", "reader")).toBeNull()
})

it("short-circuits to editor without redundant channel lookups when any readable non-DM channel is linked", async () => {
  mocks.channels.mockResolvedValue([{ channelId: "read-only-dm", channelType: "dm" }, { channelId: "server-text", channelType: "text" }])
  expect(await pageAccessRole({} as never, "artifact", "reader")).toBe("editor")
  expect(mocks.communicate).not.toHaveBeenCalled()
})

it("keeps an independent upload available to its publisher before any message links exist", async () => {
  mocks.channels.mockResolvedValue([])
  expect(await pageAccessRole({} as never, "artifact", "publisher")).toBe("editor")
  expect(mocks.communicate).not.toHaveBeenCalled()
})
