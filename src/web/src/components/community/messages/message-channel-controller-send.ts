import type { MentionType } from "@alook/shared"
import type { SendAttachment } from "./composer"
import type { ReplyTarget, Viewer } from "./message-channel-controller-types"
import { acceptMessageIntent, prepareMessageIntent } from "@/lib/community/message-send-intent"
import type { SendMessageArgs } from "@/hooks/community/mutations/messages"
import type { UploadFileArgs, UploadFileResult } from "@/hooks/community/mutations/uploads"
import type { CommunityRuntime } from "@/stores/community/runtime"
import { communityWsEndTyping } from "@/hooks/community/use-community-ws"

type ChannelMessageScope = Extract<import("@/lib/community/message-stream").MessageScope, { kind: "channel" }>

type UploadFile = (input: Omit<UploadFileArgs, "target"> & { target: { channelId: string } }) => Promise<UploadFileResult>

type SendMessage = (input: SendMessageArgs & { nonce: string }) => Promise<unknown>

export async function runAcceptedMessageIntent({
  runtime,
  assertActive,
  assertCommand,
  messageScope,
  nonce,
  uploadFileAsync,
  sendMessageAsync,
  channelId,
  forumParentChannelId,
  serverId,
  viewer,
}: {
  runtime: CommunityRuntime
  assertActive?: (() => void) & { signal: AbortSignal }
  assertCommand: () => void
  messageScope: ChannelMessageScope
  nonce: string
  uploadFileAsync: UploadFile
  sendMessageAsync: SendMessage
  channelId: string
  forumParentChannelId?: string
  serverId: string
  viewer: Viewer
}) {
  const generation = runtime.lifecycle.get().generation
  const assertOwner = () => {
    assertCommand()
    const state = runtime.lifecycle.get()
    if (!state.active || state.generation !== generation) throw new DOMException("Retired send owner", "AbortError")
  }
  const assert = assertOwner
  const prepared = await prepareMessageIntent({ runtime, scope: messageScope, nonce, assertOwner, assertActive, assertCommand, uploadFileAsync, target: { channelId } })
  if (!prepared.ok) return
  const { payload, attachments: uploadedAttachments } = prepared

  try {
    assert()
  } catch {
    try { assertOwner(); runtime.messageStream.actions.dispatch(messageScope, { type: "postFail", nonce }) } catch {}
    return
  }
  try {
    await sendMessageAsync({
      assertActive,
      assertCommand,
      serverId,
      channelId,
      forumParentChannelId,
      content: payload.message.content ?? "",
      replyToId: payload.message.replyTo?.id,
      mentionType: payload.mentionType,
      attachments: uploadedAttachments,
      nonce,
      author: viewer,
    })
  } catch {
    return
  }
}

export function acceptChannelMessage({
  runtime,
  markdown,
  attachments,
  mentionType,
  messageScope,
  viewer,
  replyTo,
  runAcceptedIntent,
  channelId,
  clearReply,
}: {
  runtime: CommunityRuntime
  markdown: string
  attachments?: SendAttachment[]
  mentionType?: MentionType
  messageScope: ChannelMessageScope
  viewer: Viewer
  replyTo: ReplyTarget | null
  runAcceptedIntent: (nonce: string) => Promise<void>
  channelId: string
  clearReply: () => void
}): boolean {
  const nonce = acceptMessageIntent(runtime, messageScope, { content: markdown, attachments, mentionType, author: viewer, replyTo: replyTo ?? undefined })
  if (nonce === undefined) return false
  void runAcceptedIntent(nonce)
  communityWsEndTyping(runtime, { channelId })
  clearReply()
  return true
}
