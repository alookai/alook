import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import {
  canonicalAuthorMentionText,
  useAuthorMentionInsertion,
} from "./use-author-mention-insertion"
import type { ComposerHandle } from "./composer"

describe("author mention insertion", () => {
  it("builds the existing canonical plain-text token with trailing spacing", () => {
    expect(canonicalAuthorMentionText({
      name: "Alice Smith",
      discriminator: "0042",
    })).toBe("@Alice Smith#0042")
  })

  it("resolves roster and viewer authors and forwards text unchanged to the live composer", () => {
    let latest!: ReturnType<typeof useAuthorMentionInsertion>
    function Probe() {
      latest = useAuthorMentionInsertion({
        members: [{ userId: "alice_1", name: "Alice Smith", discriminator: "0042" }],
        viewerUserId: "viewer_1",
        viewerName: "Viewer",
        viewerDiscriminator: "1111",
      })
      return null
    }
    act(() => {
      TestRenderer.create(createElement(Probe))
    })

    expect(latest.resolveAuthorMentionText("alice_1")).toBe("@Alice Smith#0042")
    expect(latest.resolveAuthorMentionText("viewer_1")).toBe("@Viewer#1111")
    expect(latest.resolveAuthorMentionText("missing")).toBeNull()

    const insertTextAtCaret = vi.fn()
    latest.composerRef.current = { insertTextAtCaret } as unknown as ComposerHandle
    act(() => latest.insertMentionText("@Alice Smith#0042"))
    expect(insertTextAtCaret).toHaveBeenCalledOnce()
    expect(insertTextAtCaret).toHaveBeenCalledWith("@Alice Smith#0042")
  })
})
