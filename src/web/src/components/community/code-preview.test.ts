import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CodeHighlightResult } from "@/lib/community/code-highlight"
import { tid } from "@/lib/community/testids"
import { CodePreview } from "./code-preview"

const highlightCodeMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/community/code-highlight", () => ({
  MAX_CODE_HIGHLIGHT_LINES: 2_000,
  highlightCode: highlightCodeMock,
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => React.createElement("button", props, children),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  highlightCodeMock.mockReset().mockResolvedValue({ kind: "plain", lines: null, reason: null })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("CodePreview", () => {
  it("renders as a flat Sheet panel without card chrome", async () => {
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(CodePreview, {
        content: "plain source",
        language: null,
      }))
    })
    await flush()

    const preview = renderer!.root.findByProps({ "data-testid": tid.codePreview })
    expect(preview.props.className).not.toMatch(/rounded|\bborder\b|bg-/)
    const toolbar = preview.findAllByType("div")[0]!
    expect(toolbar.props.className).toContain("border-b")
    expect(toolbar.props.className).not.toMatch(/bg-/)
  })

  it("renders language, line numbers, and theme-aware Shiki tokens", async () => {
    highlightCodeMock.mockResolvedValue({
      kind: "highlighted",
      lines: [
        [{ content: "const", light: { color: "#111111" }, dark: { color: "#eeeeee" } }],
        [{ content: "answer", light: { color: "#222222" }, dark: { color: "#dddddd" } }],
      ],
      reason: null,
    })
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(CodePreview, {
        content: "const\nanswer",
        language: "typescript",
      }))
    })
    await flush()

    expect(renderer!.root.findByProps({ "data-testid": tid.codePreviewLanguage }).children).toEqual(["TypeScript"])
    expect(renderer!.root.findAll((node) => node.type === "span" && node.props["aria-hidden"] === "true").map((node) => node.children[0]))
      .toEqual(["1", "2"])
    const token = renderer!.root.findAllByType("code")[0]!.findByType("span")
    expect(token.props.style).toMatchObject({
      "--code-token-light": "#111111",
      "--code-token-dark": "#eeeeee",
    })
    expect(token.children).toEqual(["const"])
  })

  it("toggles wrapping and copies the exact original source", async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    const source = "{\n  \"raw\": true\n}"
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(CodePreview, { content: source, language: "json" }))
    })
    await flush()

    const wrap = renderer!.root.findByProps({ "data-testid": tid.codePreviewWrap })
    expect(wrap.props["aria-pressed"]).toBe(false)
    act(() => wrap.props.onClick())
    expect(renderer!.root.findByProps({ "data-testid": tid.codePreviewWrap }).props["aria-pressed"]).toBe(true)

    const copy = renderer!.root.findByProps({ "data-testid": tid.codePreviewCopy })
    await act(async () => copy.props.onClick())
    expect(writeText).toHaveBeenCalledWith(source)
    expect(renderer!.root.findByProps({ "data-testid": tid.codePreviewCopy }).props["aria-label"]).toBe("Copied")
  })

  it("offers retry feedback when clipboard access fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"))
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(CodePreview, {
        content: "exact source",
        language: null,
      }))
    })
    await flush()

    const copy = renderer!.root.findByProps({ "data-testid": tid.codePreviewCopy })
    await act(async () => copy.props.onClick())
    expect(writeText).toHaveBeenCalledWith("exact source")
    expect(renderer!.root.findByProps({ "data-testid": tid.codePreviewCopy }).props["aria-label"]).toBe("Copy failed")
  })

  it("shows the highlight budget or loader failure while retaining plain text", async () => {
    highlightCodeMock.mockResolvedValue({
      kind: "plain",
      lines: null,
      reason: "Syntax highlighting disabled for large files",
    })
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(CodePreview, {
        content: "still readable",
        language: "json",
      }))
    })
    await flush()

    expect(renderer!.root.findByProps({ "data-testid": tid.codePreviewStatus }).children)
      .toEqual(["Syntax highlighting disabled for large files"])
    expect(renderer!.root.findByType("code").children).toEqual(["still readable"])
  })

  it("renders active source as text nodes without mounting uploaded elements", async () => {
    const source = '<script>globalThis.pwned = true</script><iframe src="https://example.com"></iframe><svg onload="pwn()" />'
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(CodePreview, { content: source, language: "html" }))
    })
    await flush()

    expect(renderer!.root.findByType("code").children).toEqual([source])
    expect(renderer!.root.findAllByType("script")).toHaveLength(0)
    expect(renderer!.root.findAllByType("iframe")).toHaveLength(0)
    expect(renderer!.root.findAll((node) => node.props.dangerouslySetInnerHTML !== undefined)).toHaveLength(0)
  })

  it("ignores a stale tokenization result after the attachment changes", async () => {
    const first = deferred<CodeHighlightResult>()
    const second = deferred<CodeHighlightResult>()
    highlightCodeMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(CodePreview, {
        content: "old",
        language: "typescript",
      }))
    })
    await act(async () => {
      renderer!.update(React.createElement(CodePreview, {
        content: "new",
        language: "typescript",
      }))
    })

    second.resolve({
      kind: "highlighted",
      lines: [[{ content: "new-token", light: {}, dark: {} }]],
      reason: null,
    })
    await flush()
    expect(renderer!.root.findByType("code").findByType("span").children).toEqual(["new-token"])

    first.resolve({
      kind: "highlighted",
      lines: [[{ content: "old-token", light: {}, dark: {} }]],
      reason: null,
    })
    await flush()
    expect(renderer!.root.findByType("code").findByType("span").children).toEqual(["new-token"])
  })
})
