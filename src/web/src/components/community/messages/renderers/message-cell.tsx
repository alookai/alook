"use client"

import { Component, createContext, useContext, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { CurrentMessageCell } from "./current-message-cell"
import type { MessageCellPresentation, MessageCellPresentationProps, MessageRendererId } from "./message-cell-types"

type Presentation = { id: MessageRendererId; component: MessageCellPresentation | null; revision: number; onError?: () => void; onReturnCurrent?: () => void }
export const MessageRendererContext = createContext<Presentation>({ id: "current", component: CurrentMessageCell, revision: 0 })

export function MessageRendererError({ onReturnCurrent }: { onReturnCurrent?: () => void }) {
  return <div role="alert" className="flex min-w-0 flex-col items-start gap-2 p-2 text-sm"><p>The selected renderer could not display messages.</p><Button variant="outline" size="sm" onClick={onReturnCurrent}>Return to Current</Button></div>
}
class CellBoundary extends Component<{ children: ReactNode; onError?: () => void; onReturnCurrent?: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { this.props.onError?.() }
  render() { return this.state.failed ? <MessageRendererError onReturnCurrent={this.props.onReturnCurrent} /> : this.props.children }
}
export function MessageCell(props: MessageCellPresentationProps) {
  const presentation = useContext(MessageRendererContext)
  const Renderer = presentation.component
  return (
    <CellBoundary key={presentation.revision} onError={presentation.onError} onReturnCurrent={presentation.onReturnCurrent}>
      {Renderer ? <Renderer {...props} /> : <MessageRendererError onReturnCurrent={presentation.onReturnCurrent} />}
    </CellBoundary>
  )
}
