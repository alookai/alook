import { mermaid, cjk, math } from "@/lib/streamdown-plugins"
import { MessageBodyView } from "./message-body-view"
import type { ComponentProps } from "react"

type MessageBodyProps = Omit<ComponentProps<typeof MessageBodyView>, "plugins">

export default function FullMessageBody(props: MessageBodyProps) {
  return <MessageBodyView {...props} plugins={{ mermaid, cjk, math }} />
}
