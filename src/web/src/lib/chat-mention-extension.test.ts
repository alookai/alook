import { describe, it, expect } from "vitest";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { buildChatMentionExtension, mentionTokensToHtml } from "./chat-mention-extension";

/**
 * A Mention node serializes to a `@[Name](agentId)` token in markdown — the
 * wire format the backend parses by id. This guards against a TipTap upgrade
 * silently regressing the serializer or adding `\@` escaping.
 */

// StarterKit is a bundle; the MarkdownManager wants flat extensions.
function flatten(ext: ReturnType<typeof StarterKit.configure>) {
  const out: unknown[] = [];
  const visit = (e: { config?: { addExtensions?: () => unknown[] } }) => {
    if (e?.config?.addExtensions) {
      try {
        for (const c of e.config.addExtensions.call(e)) visit(c as typeof e);
      } catch {
        /* ignore bundles that can't expand without an editor */
      }
    }
    out.push(e);
  };
  visit(ext as never);
  return out;
}

function serialize(doc: object): string {
  const extensions = [
    ...flatten(StarterKit.configure({})),
    buildChatMentionExtension(),
  ];
  const mgr = new MarkdownManager({ extensions: extensions as never });
  return mgr.serialize(doc as never);
}

function para(...content: object[]) {
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

const mention = (id: string, label: string) => ({
  type: "mention",
  attrs: { id, label },
});
const text = (t: string) => ({ type: "text", text: t });

describe("chat mention markdown serialization", () => {
  it("serializes a mention to a @[Name](id) token", () => {
    expect(serialize(para(text("hi "), mention("a1", "Alice"), text(" there")))).toBe(
      "hi @[Alice](a1) there",
    );
  });

  it("does not escape the @ (no \\@)", () => {
    const md = serialize(para(mention("a1", "Alice")));
    expect(md).toBe("@[Alice](a1)");
    expect(md).not.toContain("\\@");
  });

  it("falls back to id in the label slot when label is null/undefined", () => {
    const md = serialize(
      para({ type: "mention", attrs: { id: "agent-7", label: null } }),
    );
    expect(md).toBe("@[agent-7](agent-7)");
  });

  it("serializes multiple mentions in one line", () => {
    expect(
      serialize(
        para(mention("a1", "Alice"), text(" and "), mention("b2", "Bob"), text(" hi")),
      ),
    ).toBe("@[Alice](a1) and @[Bob](b2) hi");
  });
});

describe("mentionTokensToHtml (draft restore)", () => {
  it("converts a token to mention HTML the parseHTML step can rebuild", () => {
    expect(mentionTokensToHtml("Hey @[Ada](ag_ada1) do this")).toBe(
      'Hey <span data-type="mention" data-id="ag_ada1" data-label="Ada"></span> do this',
    );
  });

  it("converts multiple tokens", () => {
    expect(mentionTokensToHtml("@[Ada](ag_1) and @[Bob](ag_2)")).toBe(
      '<span data-type="mention" data-id="ag_1" data-label="Ada"></span> and <span data-type="mention" data-id="ag_2" data-label="Bob"></span>',
    );
  });

  it("leaves a normal markdown link untouched", () => {
    const link = "see [docs](https://example.com/a.b:c)";
    expect(mentionTokensToHtml(link)).toBe(link);
  });
});
