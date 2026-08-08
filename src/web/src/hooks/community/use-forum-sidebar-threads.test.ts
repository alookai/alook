import { beforeEach, describe, expect, it, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  patchForumSidebarActivity,
  patchForumSidebarUnread,
  projectForumSidebarThreads,
  removeForumSidebarThread,
  type SidebarThreadEnvelope,
  useForumSidebarThreads,
} from "./use-forum-sidebar-threads"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

const envelope = (ids: string[]): SidebarThreadEnvelope => ({
  channels: ids.map((id, index) => ({
    id,
    name: `fallback-${id}`,
    parentChannelId: "forum-1",
    parentMessageId: `opener-${id}`,
    activityAt: `2026-08-08T0${index}:00:00.000Z`,
    expiresAt: `2026-08-11T0${index}:00:00.000Z`,
    unread: index === 0,
  })),
  included: {
    parentMessages: ids.map((id) => ({ id: `opener-${id}`, content: `title-${id}` })),
  },
  serverNow: "2026-08-08T00:00:00.000Z",
})

function Capture({ retainId, onRender }: {
  retainId: string | null
  onRender: (ids: string[]) => void
}) {
  const result = useForumSidebarThreads("server-1", retainId)
  onRender(result.threads.map((thread) => thread.id))
  return null
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 40 && !predicate(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe("useForumSidebarThreads", () => {
  it("keeps the cached list painted while a retainId-specific view is loading", async () => {
    let resolveRetained: ((value: SidebarThreadEnvelope) => void) | undefined
    apiFetchMock
      .mockResolvedValueOnce(envelope(["thread-1"]))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveRetained = resolve
      }))

    const renders: string[][] = []
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, {
            retainId: null,
            onRender: (ids) => renders.push(ids),
          }),
        ),
      )
    })
    await waitFor(() => renders.at(-1)?.[0] === "thread-1")
    const switchRenderStart = renders.length

    await act(async () => {
      renderer!.update(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, {
            retainId: "thread-2",
            onRender: (ids) => renders.push(ids),
          }),
        ),
      )
    })

    expect(renders.slice(switchRenderStart)).not.toContainEqual([])
    expect(renders.at(-1)).toEqual(["thread-1"])
    expect(apiFetchMock.mock.calls[1]?.[0]).toContain("retainId=thread-2")

    await act(async () => {
      resolveRetained?.(envelope(["thread-2"]))
    })
    await waitFor(() => renders.at(-1)?.[0] === "thread-2")
    expect(renders.at(-1)).toEqual(["thread-2"])
    expect(renders.slice(switchRenderStart)).not.toContainEqual([])
    renderer!.unmount()
  })

  it("projects opener titles and patches activity/removal without mutating the source", () => {
    const source = envelope(["thread-1", "thread-2"])
    const threads = projectForumSidebarThreads(source)
    const data = { ...source, threads }

    expect(threads.map((thread) => thread.title)).toEqual(["title-thread-1", "title-thread-2"])
    const patched = patchForumSidebarActivity(
      data,
      "thread-1",
      "forum-1",
      "2026-08-09T00:00:00.000Z",
    )
    expect(patched?.threads[0]?.id).toBe("thread-1")
    expect(patched?.threads[0]?.expiresAt).toBe("2026-08-12T00:00:00.000Z")
    expect(data.threads[0]?.activityAt).toBe("2026-08-08T00:00:00.000Z")
    expect(removeForumSidebarThread(patched, "thread-1")?.threads.map((thread) => thread.id))
      .toEqual(["thread-2"])
    expect(patchForumSidebarUnread(data, "thread-1", false)?.threads[0]?.unread).toBe(false)
  })
})
