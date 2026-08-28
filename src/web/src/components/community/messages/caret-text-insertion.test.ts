import { describe, expect, it } from "vitest"
import { extractMentionedUserIds } from "@alook/shared"
import { textNodeForCaretInsertion } from "./caret-text-insertion"

const ALICE = { userId: "alice_1", name: "Alice", discriminator: "0042" }
const TOKEN = "@Alice#0042"

function insertAtCaret(content: string, caret: number): string {
  const insertion = textNodeForCaretInsertion(TOKEN, {
    selection: { from: caret, to: caret },
    doc: {
      content: { size: content.length },
      textBetween: (from, to) => content.slice(from, to),
    },
  })
  expect(insertion.type).toBe("text")
  return `${content.slice(0, caret)}${insertion.text}${content.slice(caret)}`
}

describe("caret text boundaries", () => {
  it("separates an inserted token from identifier text on both sides", () => {
    const content = insertAtCaret("helloworld", 5)
    expect(content).toBe("hello @Alice#0042 world")
    expect(extractMentionedUserIds(content, [ALICE])).toEqual(["alice_1"])
  })

  it("does not add a leading space at the start of the document", () => {
    const content = insertAtCaret("hello", 0)
    expect(content).toBe("@Alice#0042 hello")
    expect(extractMentionedUserIds(content, [ALICE])).toEqual(["alice_1"])
  })

  it("does not duplicate existing whitespace or punctuation boundaries", () => {
    expect(insertAtCaret("hello world", 6)).toBe("hello @Alice#0042 world")
    expect(insertAtCaret("hello,world", 6)).toBe("hello,@Alice#0042 world")
    expect(insertAtCaret("hello , world", 7)).toBe("hello ,@Alice#0042 world")
  })
})
