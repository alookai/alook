import React from "react"
import { act, fireEvent, render } from "@/test/react-dom-harness"
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
    let renderer: ReturnType<typeof render>
    await act(async () => {
      renderer = render(React.createElement(CodePreview, {
        content: "plain source",
        language: null,
      }))
    })
    await flush()

    const preview = renderer!.getByTestId(tid.codePreview)
    expect(preview.className).not.toMatch(/rounded|\bborder\b|bg-/)
    const toolbar = preview.querySelector("div")!
    expect(toolbar.className).not.toMatch(/\bborder\b|border-|bg-/)
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
    let renderer: ReturnType<typeof render>
    await act(async () => {
      renderer = render(React.createElement(CodePreview, {
        content: "const\nanswer",
        language: "typescript",
      }))
    })
    await flush()

    expect(renderer!.getByTestId(tid.codePreviewLanguage)).toHaveTextContent("TypeScript")
    expect([...renderer!.container.querySelectorAll('span[aria-hidden="true"]')]
      .map((node) => node.textContent))
      .toEqual(["1", "2"])
    const token = renderer!.container.querySelector<HTMLElement>("code span")!
    expect(token.style.getPropertyValue("--code-token-light")).toBe("#111111")
    expect(token.style.getPropertyValue("--code-token-dark")).toBe("#eeeeee")
    expect(token).toHaveTextContent("const")
  })

  it("toggles wrapping and copies the exact original source", async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    const source = "{\n  \"raw\": true\n}"
    let renderer: ReturnType<typeof render>
    await act(async () => {
      renderer = render(React.createElement(CodePreview, { content: source, language: "json" }))
    })
    await flush()

    const wrap = renderer!.getByTestId(tid.codePreviewWrap)
    expect(wrap).toHaveAttribute("aria-pressed", "false")
    fireEvent.click(wrap)
    expect(renderer!.getByTestId(tid.codePreviewWrap)).toHaveAttribute("aria-pressed", "true")

    const copy = renderer!.getByTestId(tid.codePreviewCopy)
    await act(async () => {
      fireEvent.click(copy)
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith(source)
    expect(renderer!.getByTestId(tid.codePreviewCopy)).toHaveAttribute("aria-label", "Copied")
  })

  it("offers retry feedback when clipboard access fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"))
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    let renderer: ReturnType<typeof render>
    await act(async () => {
      renderer = render(React.createElement(CodePreview, {
        content: "exact source",
        language: null,
      }))
    })
    await flush()

    const copy = renderer!.getByTestId(tid.codePreviewCopy)
    await act(async () => {
      fireEvent.click(copy)
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith("exact source")
    expect(renderer!.getByTestId(tid.codePreviewCopy)).toHaveAttribute("aria-label", "Copy failed")
  })

  it("shows the highlight budget or loader failure while retaining plain text", async () => {
    highlightCodeMock.mockResolvedValue({
      kind: "plain",
      lines: null,
      reason: "Syntax highlighting disabled for large files",
    })
    let renderer: ReturnType<typeof render>
    await act(async () => {
      renderer = render(React.createElement(CodePreview, {
        content: "still readable",
        language: "json",
      }))
    })
    await flush()

    expect(renderer!.getByTestId(tid.codePreviewStatus))
      .toHaveTextContent("Syntax highlighting disabled for large files")
    expect(renderer!.container.querySelector("code")).toHaveTextContent("still readable")
  })

  it("renders active source as text nodes without mounting uploaded elements", async () => {
    const source = '<script>globalThis.pwned = true</script><iframe src="https://example.com"></iframe><svg onload="pwn()" />'
    let renderer: ReturnType<typeof render>
    await act(async () => {
      renderer = render(React.createElement(CodePreview, { content: source, language: "html" }))
    })
    await flush()

    expect(renderer!.container.querySelector("code")).toHaveTextContent(source)
    expect(renderer!.container.querySelectorAll("script")).toHaveLength(0)
    expect(renderer!.container.querySelectorAll("iframe")).toHaveLength(0)
  })

  it("ignores a stale tokenization result after the attachment changes", async () => {
    const first = deferred<CodeHighlightResult>()
    const second = deferred<CodeHighlightResult>()
    highlightCodeMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    let renderer: ReturnType<typeof render>
    await act(async () => {
      renderer = render(React.createElement(CodePreview, {
        content: "old",
        language: "typescript",
      }))
    })
    await act(async () => {
      renderer!.rerender(React.createElement(CodePreview, {
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
    expect(renderer!.container.querySelector("code span")).toHaveTextContent("new-token")

    first.resolve({
      kind: "highlighted",
      lines: [[{ content: "old-token", light: {}, dark: {} }]],
      reason: null,
    })
    await flush()
    expect(renderer!.container.querySelector("code span")).toHaveTextContent("new-token")
  })
})
