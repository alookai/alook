"use client"

import { memo, useEffect, useState } from "react"
import { cjk } from "@streamdown/cjk"
import { useCommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation"
import type { OpenProfile } from "../social/profile-types"
import type { MessagePerspective } from "./message-presentation-types"
import { MessageBodyView } from "./message-body-view"

type MessageBodyProps = {
  text: string
  onOpenProfile?: OpenProfile
  perspective?: MessagePerspective
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

export const MessageBody = memo(function MessageBody(props: MessageBodyProps) {
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
})
