"use client"

import { Fragment, memo, useEffect, useState } from "react"
import { cjk } from "@streamdown/cjk"
import { useCommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation"
import type { OpenProfile } from "../social/profile-types"
import type { MessagePerspective } from "./message-presentation-types"
import { MessageBodyView } from "./message-body-view"

import type { Attachment } from "@/lib/community/models/message"

type MessageBodyProps = {
  attachments?: readonly Attachment[]
  text: string
  onOpenProfile?: OpenProfile
  perspective?: MessagePerspective
}

const PLAIN_TEXT_DISALLOWED = /[*_`~[\]<>\\|@$#/&:]|\r|\n\n|(?:^|\n)(?:[ \t]|[+\-=](?:\s|[+\-=]|$)|\d+[.)]\s)|\bwww\./i

export function isPlainTextMessageBody(text: string): boolean {
  return text.length > 0 && !PLAIN_TEXT_DISALLOWED.test(text)
}

type FullPlugins = typeof import("./message-body-full")["default"]
const previewPlugins = { cjk }
let fullPlugins: FullPlugins | null = null
let loadingPlugins: Promise<FullPlugins> | null = null

function loadFullPlugins() {
  return loadingPlugins ??= import("./message-body-full").then((module) => {
    fullPlugins = module.default
    return fullPlugins
  })
}

export function preloadMessageBodyPlugins(): void {
  if (fullPlugins) return
  void loadFullPlugins().catch(() => undefined)
}

function PlainTextMessageBody({ text }: { text: string }) {
  const lines = text.includes("\n") ? text.split("\n") : null
  return (
    <div
      data-community-message-body
      data-message-body-mode="plain"
      className="markdown markdown-chat flex flex-col gap-2 wrap-anywhere select-text text-[15px] leading-snug text-foreground"
    >
      <div className="message-markdown-blocks flex flex-col gap-2 space-y-0">
        <p>
          {lines
            ? lines.map((line, index) => (
                <Fragment key={index}>
                  {index > 0 && <br />}
                  {line}
                </Fragment>
              ))
            : text}
        </p>
      </div>
    </div>
  )
}

function RichMessageBody(props: MessageBodyProps) {
  const preview = useCommunityPreviewNavigation()
  const [plugins, setPlugins] = useState(() => fullPlugins)
  const [loadError, setLoadError] = useState<unknown>(null)
  useEffect(() => {
    if (preview || plugins) return
    let active = true
    void loadFullPlugins().then(
      (loaded) => { if (active) setPlugins(loaded) },
      (error: unknown) => { if (active) setLoadError(error) },
    )
    return () => { active = false }
  }, [preview, plugins])
  if (loadError) throw loadError
  return <MessageBodyView {...props} plugins={preview ? previewPlugins : plugins ?? previewPlugins} />
}

export const MessageBody = memo(function MessageBody(props: MessageBodyProps) {
  if (isPlainTextMessageBody(props.text)) {
    return <PlainTextMessageBody text={props.text} />
  }
  return <RichMessageBody {...props} />
})
