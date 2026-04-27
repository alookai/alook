import { vi } from "vitest"

export function createMockBrowser() {
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue({
      click: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
    }),
    $: vi.fn().mockResolvedValue(null),
    evaluate: vi.fn().mockResolvedValue([]),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }

  const browser = {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  }

  return { browser, page }
}

export function createMockDO() {
  const doFetch = vi.fn().mockResolvedValue(Response.json({ ok: true }))
  const mockStub = { fetch: doFetch }
  const mockIdFromName = vi.fn().mockReturnValue("do-id-1")
  const mockGet = vi.fn().mockReturnValue(mockStub)
  const meetingBot = { idFromName: mockIdFromName, get: mockGet } as unknown as DurableObjectNamespace

  return { meetingBot, doFetch, mockIdFromName, mockGet }
}

export function createMockFetcher() {
  const fetchFn = vi.fn().mockResolvedValue(Response.json({ ok: true }))
  const fetcher = { fetch: fetchFn } as unknown as Fetcher
  return { fetcher, fetch: fetchFn }
}
