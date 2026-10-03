import React, { type ReactNode } from "react"
import { render, renderHook, type RenderOptions, type RenderHookOptions } from "./react-dom-harness"
import { CommunityTestProvider } from "./community-owner-fixture"
import { beforeEach } from "vitest"
import { createCommunityQueryOwner } from "./community-query-owner"

let owner: Awaited<ReturnType<typeof createCommunityQueryOwner>>
beforeEach(async () => { owner = await createCommunityQueryOwner() })

function createWrapper(outer?: RenderOptions["wrapper"]) {
  const { client, registry } = owner
  return function Owner({ children }: { children: ReactNode }) {
    return <CommunityTestProvider client={client} registry={registry} retainOwner>{outer ? React.createElement(outer, null, children) : children}</CommunityTestProvider>
  }
}

export function renderCommunity(node: ReactNode, options?: RenderOptions) {
  return render(node, { ...options, wrapper: createWrapper(options?.wrapper) })
}

export function renderCommunityHook<Result, Props>(hook: (props: Props) => Result, options?: RenderHookOptions<Props>) {
  return renderHook(hook, { ...options, wrapper: createWrapper(options?.wrapper) })
}
