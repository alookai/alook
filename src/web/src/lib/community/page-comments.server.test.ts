import { expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ upload: vi.fn(async (_bucket: unknown, _file: File) => "attachments/hash"), attachment: vi.fn(async () => ({ id: "full-feedback" })), send: vi.fn() }))
vi.mock("./upload", () => ({ putAttachmentContent: mocks.upload }))
vi.mock("./message-send.server", () => ({ handleHumanSend: mocks.send }))
vi.mock("@alook/shared", async () => { const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared"); return { ...actual, queries: { ...actual.queries, user: { getUserPublic: async () => ({ name: "Bot", discriminator: "0001" }) }, communityAttachment: { createAttachment: mocks.attachment } } } })
import { sendPageComment } from "./page-comments.server"
it("keeps long feedback in an ordinary attachment prepared only after the message door authorizes it", async () => {
  const input = { text: "x".repeat(8000), location: "Section 2", nonce: "request" }
  const page = { id: "page", artifactId: "artifact", messageId: "source", botId: "bot", channelId: "channel", channelType: "text", createdAt: "now" }
  await sendPageComment({} as never, "reader", {} as never, page as never, input)
  expect(mocks.upload).not.toHaveBeenCalled()
  const args = mocks.send.mock.calls[0] as unknown[]
  expect(args[1]).toBe("reader")
  expect(args[4]).toMatchObject({ nonce: "request", replyToId: "source" })
  const prepared = await (args[6] as { prepare: () => Promise<{ content: string; attachments: string[] }> }).prepare()
  expect(prepared.content.length).toBeLessThanOrEqual(4000)
  expect(prepared.attachments).toEqual(["full-feedback"])
  const file = mocks.upload.mock.calls[0]![1] as File
  expect(await file.text()).toContain(input.text)
  expect(mocks.attachment).toHaveBeenCalledWith({}, expect.objectContaining({ uploaderId: "reader", r2Key: "attachments/hash" }))
})
