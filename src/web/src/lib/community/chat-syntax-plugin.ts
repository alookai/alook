import type { Handler, Handlers } from "mdast-util-to-hast"
import type { Element } from "hast"
import type { MentionNode, ChannelRefNode, ServerRefNode } from "@alook/shared/chat-syntax"
import type { SpoilerNode } from "@alook/shared/spoiler-syntax"
export { chatSyntaxPlugin } from "@alook/shared/chat-syntax"
export type { MentionNode, ChannelRefNode, ServerRefNode } from "@alook/shared/chat-syntax"

// `remarkRehypeOptions.handlers` — converts each custom mdast node directly
// into a hast element, skipping the HTML-string round-trip entirely. Tag
// names/attributes match the old string-spliced tags exactly
// (`<spoiler>`/`<mention data-everyone/data-tag>`/`<channelref>`) so
// `MD_ALLOWED_TAGS`/`MD_COMPONENTS` in `message-markdown.tsx` need no change.
export const chatSyntaxHandlers: Handlers = {
  spoiler: ((state, node: SpoilerNode): Element => ({
    type: "element",
    tagName: "spoiler",
    properties: {},
    children: state.all(node),
  })) as Handler,
  mention: ((_state, node: MentionNode): Element => ({
    type: "element",
    tagName: "mention",
    properties: {
      ...(node.everyone ? { dataEveryone: "1" } : {}),
      ...(node.discriminator ? { dataTag: node.discriminator } : {}),
    },
    children: [{ type: "text", value: node.value }],
  })) as Handler,
  channelRef: ((_state, node: ChannelRefNode): Element => ({
    type: "element",
    tagName: "channelref",
    properties: {},
    children: [{ type: "text", value: node.value }],
  })) as Handler,
  serverRef: ((_state, node: ServerRefNode): Element => ({
    type: "element",
    tagName: "serverref",
    properties: {},
    children: [{ type: "text", value: node.value }],
  })) as Handler,
}
