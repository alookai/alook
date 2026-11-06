import { createElement } from "react"
import { afterAll, expect, it, onTestFinished, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { useSelector } from "@tanstack/react-store"
import { createCommunityDbRegistry, getCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { act, render, screen } from "./react-dom-harness"
import { CommunityTestProvider } from "./community-owner-fixture"
import { createCommunityQueryOwner } from "./community-query-owner"
import { retireCommunityQueryOwners } from "./community-owner-cleanup"

function Lifecycle({ registry, failure }: { registry: CommunityDbRegistry; failure?: Error }) {
  const active = useSelector(registry.runtime.lifecycle, state => state.active)
  if (!active && failure) throw failure
  return createElement("p", null, `${registry.accountId} ${active ? "active" : "retired"}`)
}

async function createOwner(accountId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const registry = createCommunityDbRegistry(client, accountId)
  const retireOriginal = registry.cleanup
  const clearOriginal = client.clear.bind(client)
  onTestFinished(() => act(async () => { clearOriginal() }))
  onTestFinished(() => act(async () => { await retireOriginal() }))
  await registry.preload()
  const key = ["dom-owner-cleanup-witness", accountId]
  client.setQueryData(key, { accountId })
  return { client, registry, key }
}

it("settles real owner subscriptions through the existing RTL act and cancels pending timers", async () => {
  const owner = await createOwner("dom-visible")
  const view = render(createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true },
    createElement(Lifecycle, { registry: owner.registry })))
  expect(screen.getByText("dom-visible active")).toBeVisible()
  let timerRan = false
  const timers = new Set([setTimeout(() => { timerRan = true }, 0)])
  const owners = new Set([owner.registry])

  await retireCommunityQueryOwners(owners, { act, timers })

  expect(screen.getByText("dom-visible retired")).toBeVisible()
  expect(getCommunityDbRegistry(owner.client)).toBeNull()
  expect(owner.client.getQueryCache().getAll()).toHaveLength(0)
  expect(owners.size).toBe(0)
  expect(timers.size).toBe(0)
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  expect(timerRan).toBe(false)
  view.unmount()
})

it("retains cleanup and native React flush errors after RTL restores its original act environment", async () => {
  const a = await createOwner("dom-error-a")
  const b = await createOwner("dom-error-b")
  const renderFailure = new Error("retired view failed during the React flush")
  const cleanupFailure = new Error("registry cleanup failed after release")
  const view = render(createElement(CommunityTestProvider, { client: a.client, registry: a.registry, retainOwner: true },
    createElement(Lifecycle, { registry: a.registry, failure: renderFailure })))
  expect(screen.getByText("dom-error-a active")).toBeVisible()
  const retireOriginal = a.registry.cleanup
  let environmentDuringCleanup: unknown
  let actFailure: unknown
  const replacement = vi.spyOn(a.registry, "cleanup").mockImplementation(async () => {
    environmentDuringCleanup = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
    await retireOriginal()
    throw cleanupFailure
  })
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false)
  try {
    const observedAct = async (work: () => Promise<void>) => {
      try { await act(work) } catch (error) { actFailure = error; throw error }
    }
    const owners = new Set([a.registry, b.registry])
    const failure = await retireCommunityQueryOwners(owners, { act: observedAct }).then(() => undefined, error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toHaveLength(2)
    expect(failure.errors[0]).toBe(cleanupFailure)
    expect(failure.errors[1]).toBe(actFailure)
    expect(actFailure instanceof AggregateError ? actFailure.errors : [actFailure]).toContain(renderFailure)
    expect(environmentDuringCleanup).toBe(true)
    expect(Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")).toBe(false)
    expect(getCommunityDbRegistry(a.client)).toBeNull()
    expect(getCommunityDbRegistry(b.client)).toBeNull()
    expect(a.client.getQueryCache().getAll()).toHaveLength(0)
    expect(b.client.getQueryCache().getAll()).toHaveLength(0)
    expect(owners.size).toBe(0)
  } finally {
    replacement.mockRestore()
    vi.unstubAllGlobals()
    view.unmount()
  }
})

const nativeOwners: Awaited<ReturnType<typeof createCommunityQueryOwner>>[] = []

it("leaves prepared owners in both existing fixtures for native terminal cleanup", async () => {
  const a = await createCommunityQueryOwner("dom-native-a")
  const b = await createCommunityQueryOwner("dom-native-b")
  nativeOwners.push(a, b)
  a.client.setQueryData(["terminal-witness", "a"], { accountId: "dom-native-a" })
  b.client.setQueryData(["terminal-witness", "b"], { accountId: "dom-native-b" })
  render(createElement("div", null,
    createElement(CommunityTestProvider, { client: a.client, registry: a.registry, retainOwner: true }, createElement(Lifecycle, { registry: a.registry })),
    createElement(CommunityTestProvider, { client: b.client, registry: b.registry, retainOwner: true }, createElement(Lifecycle, { registry: b.registry }))))
  expect(screen.getByText("dom-native-a active")).toBeVisible()
  expect(screen.getByText("dom-native-b active")).toBeVisible()
  expect(getCommunityDbRegistry(a.client)).toBe(a.registry)
  expect(getCommunityDbRegistry(b.client)).toBe(b.registry)
})

afterAll(async () => {
  try {
    expect(nativeOwners).toHaveLength(2)
    for (const owner of nativeOwners) {
      expect(getCommunityDbRegistry(owner.client)).toBeNull()
      expect(owner.registry.runtime.lifecycle.get().active).toBe(false)
      expect(owner.client.getQueryCache().getAll()).toHaveLength(0)
    }
    expect(screen.queryByText("dom-native-a active")).not.toBeInTheDocument()
    expect(screen.queryByText("dom-native-b active")).not.toBeInTheDocument()
  } finally {
    await Promise.all(nativeOwners.map(async owner => {
      try { await owner.registry.cleanup() } finally { owner.client.clear() }
    }))
  }
})
