import * as React from "react"
import { renderToReadableStream } from "react-dom/server.browser"
import { hydrateRoot, type Root } from "react-dom/client"
import { act } from "@/test/react-dom-harness"
import { afterEach, expect, it, vi } from "vitest"

vi.mock("@/hooks/community/use-me-route-memory", () => ({ useMeRouteMemory: () => {} }))
vi.mock("../social/friends-route", () => ({ default: () => null }))
vi.mock("../bots/me-bots-route", () => ({ default: () => null }))
vi.mock("../machines/me-machines-route", () => ({ default: () => null }))
vi.mock("./community-pending-frame", () => ({ CommunityPendingFrame: () => <div>Loading target</div> }))

function conversationConsumer(useFrame: typeof import("./community-route-context").useCommunityRouteFrame) {
  return function ServerConversationRoute({ channelId }: { channelId: string }) {
    const { breakpoint } = useFrame()
    return <main data-channel={channelId} data-breakpoint={breakpoint}><input aria-label="Composer" defaultValue="SSR draft" /></main>
  }
}

function Application({ Route, Frame, href }: { Route: React.ComponentType<{ href: string; routeCommitted: boolean }>; Frame: typeof import("./community-route-context").CommunityRouteContext; href: string }) {
  const [breakpoint, setBreakpoint] = React.useState("unknown")
  React.useEffect(() => { setBreakpoint("desktop") }, [])
  return <Frame value={{ breakpoint } as never}><Route href={href} routeCommitted /></Frame>
}

let root: Root | undefined
let container: HTMLDivElement | undefined
let releaseLoading = () => {}
let clientRead: Promise<void> | undefined
afterEach(async () => {
  releaseLoading()
  await clientRead
  await act(async () => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  clientRead = undefined
  for (const path of ["../channels/server-conversation-route", "../social/friends-route", "../bots/me-bots-route", "../machines/me-machines-route"]) vi.doUnmock(path)
  vi.resetModules()
})

it.each([
  ["ordinary-thread", "/c/channels/server/ordinary-thread", "../channels/server-conversation-route", "ServerConversationRoute"],
  ["forum-child", "/c/channels/server/forum-child", "../channels/server-conversation-route", "ServerConversationRoute"],
  ["friends", "/c/me/friends", "../social/friends-route", "default"],
  ["bots", "/c/me/bots", "../bots/me-bots-route", "default"],
  ["machines", "/c/me/machines", "../machines/me-machines-route", "default"],
])("keeps the original %s SSR input while the client consumer module loads", async (_shape, href, path, exportName) => {
  vi.resetModules()
  const serverFrame = await import("./community-route-context")
  vi.doMock(path, () => ({ [exportName]: conversationConsumer(serverFrame.useCommunityRouteFrame) }))
  const server = await import("./community-module-route")
  const stream = await renderToReadableStream(<Application Route={server.CommunityModuleRoute} Frame={serverFrame.CommunityRouteContext} href={href} />)
  await stream.allReady
  const html = await new Response(stream).text()
  container = document.createElement("div")
  container.innerHTML = html
  document.body.appendChild(container)
  const composer = container.querySelector("input")!
  expect(composer).not.toBeNull()
  composer.value = "Early user draft"
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  releaseLoading = release
  let started!: () => void
  const loading = new Promise<void>(resolve => { started = resolve })
  vi.resetModules()
  const clientFrame = await import("./community-route-context")
  vi.doUnmock(path)
  vi.doMock(path, async () => {
    started()
    await gate
    return { [exportName]: conversationConsumer(clientFrame.useCommunityRouteFrame) }
  })
  const recoveries: unknown[] = []
  clientRead = import("./community-module-route").then(module => {
    act(() => {
      root = hydrateRoot(container!, <Application Route={module.CommunityModuleRoute} Frame={clientFrame.CommunityRouteContext} href={href} />, {
        onRecoverableError: error => { recoveries.push(error) },
      })
    })
  })
  await loading
  await act(async () => {})
  expect(container.querySelector("input")).toBe(composer)
  expect(composer.value).toBe("Early user draft")
  await act(async () => { release(); await clientRead })
  expect(container.querySelector("input")).toBe(composer)
  expect(composer.value).toBe("Early user draft")
  expect(recoveries).toEqual([])
})
