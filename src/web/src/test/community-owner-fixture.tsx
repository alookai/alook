import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react"
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query"
import { createCommunityDbRegistry, registerCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { beforeEach } from "vitest"
import { act } from "./react-dom-harness"

const owners = new Set<CommunityDbRegistry>()
const pendingRetirements = new Set<ReturnType<typeof setTimeout>>()
beforeEach(() => async () => {
  await act(async () => {
    for (const timer of pendingRetirements) clearTimeout(timer)
    pendingRetirements.clear()
    for (const registry of owners) { await registry.cleanup(); registry.queryClient.clear() }
    owners.clear()
  })
})

export function CommunityTestProvider({ client, children, userId = "viewer", registry: prepared, retainOwner = false }: { client: QueryClient; children?: ReactNode; userId?: string; registry?: CommunityDbRegistry; retainOwner?: boolean }) {
  const registry = useMemo(() => prepared ?? createCommunityDbRegistry(client, userId), [client, userId, prepared])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useLayoutEffect(() => {
    owners.add(registry)
    if (timer.current !== null) { clearTimeout(timer.current); pendingRetirements.delete(timer.current); timer.current = null }
    registry.authenticationView.setState((state) => ({ ...state, active: true }))
    const unregister = registerCommunityDbRegistry(registry)
    return () => {
      if (retainOwner) return
      timer.current = setTimeout(() => {
        pendingRetirements.delete(timer.current!)
        timer.current = null
        act(() => {
          registry.authenticationView.setState((state) => ({ active: false, generation: state.generation + 1 }))
          unregister()
        })
        void registry.cleanup().finally(() => client.clear())
      }, 0)
      pendingRetirements.add(timer.current)
    }
  }, [client, registry, retainOwner])
  return <QueryClientProvider client={client}><CommunityDbProvider registry={registry}>{children}</CommunityDbProvider></QueryClientProvider>
}
