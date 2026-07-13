import Mention from "@tiptap/extension-mention";
import { MENTION_TOKEN_RE } from "@alook/shared";

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function mentionTokensToHtml(value: string): string {
  return value.replace(
    MENTION_TOKEN_RE,
    (_m, label: string, id: string) =>
      `<span data-type="mention" data-id="${escapeAttr(id)}" data-label="${escapeAttr(label)}"></span>`,
  );
}

/**
 * Mention configured to serialize to a `@[Name](agentId)` token in markdown.
 *
 * `@tiptap/markdown` reads `renderMarkdown` off the extension config via
 * getExtensionField (keyed on the node name "mention"). The token carries the
 * stable agent id so downstream parsing (highlight-mentions, prompt-parser)
 * resolves the exact agent by id instead of guessing by display name.
 * `renderText` keeps copy / getText() emitting the human-readable `@Name`.
 *
 * These two fields aren't in TipTap's NodeConfig types (the markdown plugin
 * reads them dynamically), so the config is cast to the extend param type.
 */
type MentionExtendConfig = Parameters<typeof Mention.extend>[0];

export function buildChatMentionExtension() {
  return Mention.extend({
    markdownName: "mention",
    renderMarkdown: (node: { attrs: { id: string; label?: string | null } }) =>
      `@[${node.attrs.label ?? node.attrs.id}](${node.attrs.id})`,
    renderText: (node: { attrs: { id: string; label?: string | null } }) =>
      `@${node.attrs.label ?? node.attrs.id}`,
  } as MentionExtendConfig);
}
