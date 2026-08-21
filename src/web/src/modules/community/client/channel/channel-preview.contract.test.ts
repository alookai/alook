import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { createElement, type ReactElement } from "react"
import { describe, expect, it, vi } from "vitest"

vi.mock("../messaging", () => ({
  MessageRow: ({ m, onOpenThread }: { m: { id: string }; onOpenThread: () => void }) => {
    onOpenThread()
    return createElement("article", { className: "group", "data-message": m.id })
  },
  TypingIndicator: ({ names }: { names: string[] }) => createElement("typing", { names: names.join(",") }),
}))
vi.mock("./channel-header", () => ({
  ChannelHeader: (props: Record<string, any>) => {
    props.onToggle("members")
    return createElement("channel-header", props)
  },
}))

import { ChannelPreview } from "./channel-preview"

type TestInstance = {
  type: unknown
  children: Array<TestInstance | string>
  findAllByType: (type: unknown) => TestInstance[]
  findByProps: (props: Record<string, unknown>) => TestInstance
}
type Renderer = { root: TestInstance; toJSON: () => unknown; unmount: () => void }
const rendererModule = createRequire(import.meta.url)("react-test-renderer") as {
  act: (callback: () => void) => void
  create: (element: ReactElement) => Renderer
}
const { act } = rendererModule

function render(element: ReactElement) {
  let renderer: Renderer
  act(() => { renderer = rendererModule.create(element) })
  return renderer!
}

const message = (id: string) => ({
  id,
  type: "chat" as const,
  authorId: "user_1",
  authorName: "Alice",
  content: id,
  createdAt: "2026-08-20T00:00:00.000Z",
  grouped: false,
})

describe("ChannelPreview public contract", () => {
  it("renders the canonical header, bounded motion rows, typing state, and footer", () => {
    const renderer = render(createElement(ChannelPreview, {
      channel: "general",
      server: { id: "server_1", name: "Server", icon: null },
      headerProps: { tools: { members: false } },
      messages: [
        { message: message("m1"), target: "target-1", targetClassName: "focused" },
        { message: message("m2") },
      ],
      visibleMessages: 1,
      contentClassName: "preview-body",
      messageSlotClassName: "message-slot",
      typingNames: ["Alice"],
      footer: createElement("footer", null, "Composer"),
    }))
    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain("channel-header")
    expect(json).toContain('"data-visible":true')
    expect(json).toContain('"data-visible":false')
    expect(json).toContain('"data-motion-target":"target-1"')
    expect(json).toContain("typing")
    expect(json).toContain("Composer")
    act(() => renderer.unmount())
  })

  it("preserves bare message rows inside a named list for capture CSS", () => {
    const renderer = render(createElement(ChannelPreview, {
      header: createElement("custom-header"),
      messages: [{ message: message("m1") }],
      messageListClassName: "identity-message-content",
    }))
    expect(renderer.root.findAllByType("custom-header")).toHaveLength(1)
    const json = JSON.stringify(renderer.toJSON())
    expect(json).toMatch(/"className":"identity-message-content"[^]*"children":\[\{"type":"article"/)
    expect(json).not.toContain("data-visible")
    expect(json).not.toContain("typing")
    act(() => renderer.unmount())
  })

  it("hides the header when neither a channel nor custom header is supplied", () => {
    const renderer = render(createElement(ChannelPreview, { messages: [] }))
    expect(renderer.root.findAllByType("channel-header")).toHaveLength(0)
    act(() => renderer.unmount())
  })

  it("stays behind the root public entry without internal imports", () => {
    const source = readFileSync(new URL("./channel-preview.tsx", import.meta.url), "utf8")
    const rootEntry = readFileSync(new URL("../index.ts", import.meta.url), "utf8")
    expect(rootEntry).toContain("ChannelPreview")
    expect(source).not.toContain("/internal/")
  })
})
