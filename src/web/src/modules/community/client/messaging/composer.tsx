"use client"

import { forwardRef } from "react"
import type { SendAttachment } from "@/lib/community/models/message"
import { ComposerView, ComposerSkeleton } from "./internal/composer-view"
import { useComposerController } from "./internal/use-composer-controller"
import type { ComposerHandle, ComposerProps } from "./internal/composer-types"

export type { SendAttachment }
export type { ComposerHandle, ComposerProps } from "./internal/composer-types"
export {
  clipboardFiles,
  pendingFilesToSendAttachments,
} from "./internal/composer-file-utils"
export { ComposerSkeleton }

export const Composer = forwardRef<ComposerHandle, ComposerProps>(
  function Composer(props, ref) {
    const viewProps = useComposerController(props, ref)
    return <ComposerView {...viewProps} />
  },
)
