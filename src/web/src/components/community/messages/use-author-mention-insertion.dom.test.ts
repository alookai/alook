import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@/test/react-dom-harness"
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

  it("resolves roster and viewer authors and inserts the exact structured mention", () => {
    const rendered = renderHook(() => useAuthorMentionInsertion({
      members: [{
        id: "member_1",
        userId: "alice_1",
        name: "Alice Smith",
        discriminator: "0042",
      }],
      viewerUserId: "viewer_1",
      viewerName: "Viewer",
      viewerDiscriminator: "1111",
    }))

    expect(rendered.result.current.resolveAuthorMentionText("alice_1"))
      .toBe("@Alice Smith#0042")
    expect(rendered.result.current.resolveAuthorMentionText("viewer_1"))
      .toBe("@Viewer#1111")
    expect(rendered.result.current.resolveAuthorMentionText("missing")).toBeNull()

    const insertMentionAtCaret = vi.fn()
    rendered.result.current.composerRef.current = {
      insertMentionAtCaret,
    } as unknown as ComposerHandle
    rendered.result.current.insertMentionText("@Alice Smith#0042")

    expect(insertMentionAtCaret).toHaveBeenCalledOnce()
    expect(insertMentionAtCaret).toHaveBeenCalledWith({
      id: "member_1",
      label: "Alice Smith#0042",
    })
  })
})
