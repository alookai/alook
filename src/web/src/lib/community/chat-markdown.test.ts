import { describe, expect, it } from "vitest"
import { detectChatMentionType, extractChatMentionedUserIds } from "./chat-markdown"

const candidates = [
  { userId: "alice", name: "Alice", discriminator: "0001" },
  { userId: "bob", name: "Bob", discriminator: "0002" },
  { userId: "other-alice", name: "Alice", discriminator: "0003" },
]

describe("whole-body native Markdown mention consumption", () => {
  it.each([
    "`TOKEN`",
    "```txt\nTOKEN\n```",
    "```txt\nTOKEN",
    "    TOKEN",
    "[TOKEN](https://example.com)",
    "[label](https://example.com/TOKEN)",
    "[TOKEN][target]\n\n[target]: https://example.com",
    "<https://example.com/TOKEN>",
    "https://example.com/TOKEN",
    "$TOKEN$",
    "$$\nTOKEN\n$$",
    "\\TOKEN",
    "&#64;TOKEN",
    "&commat;TOKEN",
    "𠮷TOKEN",
    "𠀀TOKEN",
    "𝟙TOKEN",
    "TOKEN𠮷",
    "TOKEN𠀀",
    "TOKEN𝟙",
  ])("does not consume protected or literal input: %s", (template) => {
    function body(token: string): string {
      return template.includes("64;") || template.includes("commat;")
        ? template.replace("TOKEN", token.slice(1))
        : template.replace("TOKEN", token)
    }
    expect(extractChatMentionedUserIds(body("@Alice#0001"), candidates)).toEqual([])
    expect(detectChatMentionType(body("@everyone"))).toBeUndefined()
  })

  it.each([
    "TOKEN",
    "🎉TOKEN!",
    "**TOKEN**",
    "中文**TOKEN**。",
    "||TOKEN||",
    "\\\\TOKEN",
    "`TOKEN",
    "[TOKEN](unfinished",
  ])("consumes native unprotected input: %s", (template) => {
    expect(extractChatMentionedUserIds(template.replaceAll("TOKEN", "@Alice#0001"), candidates)).toEqual(["alice"])
    expect(detectChatMentionType(template.replaceAll("TOKEN", "@everyone"))).toBe("everyone")
  })

  it("keeps protection local and resolves exact tagged identities once", () => {
    const content = "`@Alice#0001` \\@Alice#0001 [@everyone](https://example.com) @Bob#0002 @Alice#0003 @Bob#0002"
    expect(extractChatMentionedUserIds(content, candidates)).toEqual(["bob", "other-alice"])
    expect(detectChatMentionType(content)).toBeUndefined()
    expect(detectChatMentionType(`${content} @everyone`)).toBe("everyone")
  })
})
