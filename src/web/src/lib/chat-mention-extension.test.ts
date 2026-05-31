import { describe, it, expect } from "vitest";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { buildChatMentionExtension } from "./chat-mention-extension";

/**
 * TODO #0 acceptance (highest-risk assumption): a Mention node must serialize
 * to byte-exact `@Name` in markdown — the wire format the backend already
 * expects. This guards against a TipTap upgrade silently regressing the
 * serializer back to `[@ id=... label=...]` or adding `\@` escaping.
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
  it("serializes a mention to byte-exact @Name", () => {
    expect(serialize(para(text("hi "), mention("a1", "Alice"), text(" there")))).toBe(
      "hi @Alice there",
    );
  });

  it("does not escape the @ (no \\@)", () => {
    const md = serialize(para(mention("a1", "Alice")));
    expect(md).toBe("@Alice");
    expect(md).not.toContain("\\@");
  });

  it("falls back to id when label is null/undefined", () => {
    // renderMarkdown uses `label ?? id`, so a null label (never the case for
    // real agent mentions, but defensive) serializes to the id.
    const md = serialize(
      para({ type: "mention", attrs: { id: "agent-7", label: null } }),
    );
    expect(md).toBe("@agent-7");
  });

  it("serializes multiple mentions in one line", () => {
    expect(
      serialize(
        para(mention("a1", "Alice"), text(" and "), mention("b2", "Bob"), text(" hi")),
      ),
    ).toBe("@Alice and @Bob hi");
  });
});
