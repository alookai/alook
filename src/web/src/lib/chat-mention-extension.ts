import Mention from "@tiptap/extension-mention";

/**
 * Mention configured to serialize to byte-exact `@Name` in markdown.
 *
 * `@tiptap/markdown` reads `renderMarkdown` off the extension config via
 * getExtensionField (keyed on the node name "mention"). Spike-verified: without
 * it the manager emits `[@ id="..." label="..."]`; with it (and no escaping)
 * `getMarkdown()` of "hi @Alice" === "hi @Alice". `renderText` keeps copy /
 * getText() in sync. See plans/chat-input-tiptap-migration.md TODO #0.
 *
 * These two fields aren't in TipTap's NodeConfig types (the markdown plugin
 * reads them dynamically), so the config is cast to the extend param type.
 */
type MentionExtendConfig = Parameters<typeof Mention.extend>[0];

export function buildChatMentionExtension() {
  return Mention.extend({
    markdownName: "mention",
    renderMarkdown: (node: { attrs: { id: string; label?: string | null } }) =>
      `@${node.attrs.label ?? node.attrs.id}`,
  } as MentionExtendConfig);
}
