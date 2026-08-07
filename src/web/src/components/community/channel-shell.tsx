import type { ReactNode } from "react"

/** Shared route chrome. Business surfaces own every hook and provide slots. */
export function ChannelShell({ header, body, panels, dialogs }: {
  header: ReactNode
  body: ReactNode
  panels?: ReactNode
  dialogs?: ReactNode
}) {
  return <>
    {header}
    {body}
    {panels}
    {dialogs}
  </>
}
