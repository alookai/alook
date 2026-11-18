import React from "react"
import { QueryClient } from "@tanstack/react-query"
import { COMMUNITY_CONTRACT_HEADER, COMMUNITY_CONTRACT_VERSION } from "@alook/shared"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { retireBotDirectoryScopes } from "@/lib/community/bot-directory-lifecycle"
import { communityKeys } from "@/lib/query-keys"
import { tid } from "@/lib/community/testids"
import { BotMembershipsSheet } from "./bot-memberships-sheet"

vi.mock("../shell/community-sheet", () => ({
  CommunitySheet: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => open ? <div>{children}</div> : null,
}))
vi.mock("@/components/avatar", () => ({ AgentAvatar: () => <span /> }))
vi.mock("../server-icon", () => ({ ServerIcon: () => <span /> }))
vi.mock("../entity-icon", () => ({ EntityIcon: () => <span /> }))

const memberships = {
  servers: [{ id: "server_1", handle: "studio#0042", name: "studio", canLeave: true, icon: null }],
  groups: [{ category: null, channels: [{ id: "channel_1", ref: "/studio#0042/work", name: "work", type: "text", visibility: "private" }] }],
}
const response = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", [COMMUNITY_CONTRACT_HEADER]: String(COMMUNITY_CONTRACT_VERSION) },
})
const fetchRequest = vi.fn<typeof fetch>()
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
const tree = (queryClient: QueryClient, botId = "bot_1", open = true, userId = "viewer") =>
  <CommunityTestProvider client={queryClient} userId={userId}>
    <BotMembershipsSheet bot={{ id: botId, name: botId }} open={open} onOpenChange={() => {}} />
  </CommunityTestProvider>
const deleteCount = () => fetchRequest.mock.calls.filter(([, options]) => options?.method === "DELETE").length
async function selectExit() {
  const button = await screen.findByTestId(tid.botMembershipsLeave("/studio#0042/work"))
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  await screen.findByRole("alertdialog")
}

describe("Bot memberships receipt and confirmation ownership", () => {
  beforeEach(() => { fetchRequest.mockReset(); vi.stubGlobal("fetch", fetchRequest) })
  afterEach(() => vi.unstubAllGlobals())

  it.each([false, true])("settles the original confirmation after read retirement without waiting for refresh; HTTP failure=%s", async failed => {
    let finish!: (value: Response) => void
    let refresh!: (value: Response) => void
    const receipt = new Promise<Response>(resolve => { finish = resolve })
    const refreshed = new Promise<Response>(resolve => { refresh = resolve })
    let dispatched = false
    fetchRequest.mockImplementation(async (_path, options) => {
      if (options?.method === "DELETE") { dispatched = true; return receipt }
      return dispatched ? refreshed : response(memberships)
    })
    const queryClient = client()
    const view = render(tree(queryClient))
    try {
      await selectExit()
      const confirm = screen.getByTestId(tid.botMembershipsConfirm)
      fireEvent.click(confirm)
      fireEvent.click(confirm)
      await waitFor(() => expect(deleteCount()).toBe(1))
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()
      const registry = getCommunityDbRegistry(queryClient)!
      await act(async () => { await retireBotDirectoryScopes(registry, [{ kind: "bot-channel", botId: "bot_1", id: "channel_1" }]) })
      expect(queryClient.getQueryData(communityKeys.botMemberships("bot_1"))).toBeUndefined()
      act(() => { finish(failed ? new Response("temporary failure", { status: 503 }) : response(null, 204)) })
      if (failed) {
        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong"))
        expect(screen.getByRole("alertdialog")).toBeVisible()
        expect(screen.getByTestId(tid.botMembershipsConfirm)).toBeDisabled()
        expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled()
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
      }
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
      expect(queryClient.getQueryData(communityKeys.botMemberships("bot_1"))).not.toMatchObject({ observed: true })
      expect(deleteCount()).toBe(1)
      if (!failed) await waitFor(() => expect(queryClient.isFetching()).toBe(1))
    } finally {
      act(() => { refresh(response({ servers: [], groups: [] })); finish(response(null, 204)) })
      await act(async () => { await queryClient.cancelQueries() })
      view.unmount(); queryClient.clear()
    }
  })

  it.each(["bot", "view", "account"] as const)("does not settle a new confirmation when an old successful receipt arrives after changing %s", async boundary => {
    let finish!: (value: Response) => void
    fetchRequest.mockImplementation(async (_path, options) => options?.method === "DELETE"
      ? new Promise<Response>(resolve => { finish = resolve }) : response(memberships))
    const original = client()
    const next = boundary === "account" ? client() : original
    const view = render(tree(original))
    try {
      await selectExit()
      fireEvent.click(screen.getByTestId(tid.botMembershipsConfirm))
      await waitFor(() => expect(deleteCount()).toBe(1))
      if (boundary === "view") view.rerender(tree(original, "bot_1", false))
      view.rerender(tree(next, boundary === "bot" ? "bot_2" : "bot_1", true, boundary === "account" ? "other-viewer" : "viewer"))
      if (boundary === "view") {
        expect(screen.queryByRole("alertdialog")).toBeNull()
        expect(screen.getByTestId(tid.botMembershipsLeave("/studio#0042/work"))).toBeDisabled()
        act(() => { finish(response(null, 204)) })
        await waitFor(() => expect(original.isMutating()).toBe(0))
        expect(screen.queryByRole("alertdialog")).toBeNull()
        expect(screen.queryByRole("alert")).toBeNull()
      }
      if (boundary === "account" && screen.queryByRole("alertdialog")) {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
      }
      await selectExit()
      const current = screen.getByRole("alertdialog")
      act(() => { finish(response(null, 204)) })
      await waitFor(() => expect(original.isMutating()).toBe(0))
      expect(screen.getByRole("alertdialog")).toBe(current)
      expect(screen.queryByRole("alert")).toBeNull()
      expect(deleteCount()).toBe(1)
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    } finally {
      act(() => { finish(response(null, 204)) })
      view.unmount(); original.clear(); next.clear()
    }
  })

  it("keeps historical membership rows disabled until the actual GET confirms them", async () => {
    let finish!: (value: Response) => void
    fetchRequest.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve }))
    const queryClient = client()
    queryClient.setQueryData(communityKeys.botMemberships("bot_1"), {
      observed: false,
      servers: [{ ...memberships.servers[0], channels: [{ id: "/studio#0042/work", channelId: "channel_1", name: "work", type: "text", visibility: "private", canLeave: true }] }],
    })
    const view = render(tree(queryClient))
    try {
      const leave = screen.getByTestId(tid.botMembershipsLeave("/studio#0042/work"))
      expect(leave).toBeDisabled()
      fireEvent.click(leave)
      expect(screen.queryByRole("alertdialog")).toBeNull()
      await waitFor(() => expect(fetchRequest).toHaveBeenCalledTimes(1))
      expect(deleteCount()).toBe(0)
      act(() => { finish(response(memberships)) })
      await selectExit()
      expect(screen.getByTestId(tid.botMembershipsConfirm)).toBeEnabled()
      expect(deleteCount()).toBe(0)
    } finally {
      act(() => { finish(response(memberships)) })
      view.unmount(); queryClient.clear()
    }
  })
})
