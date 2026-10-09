import { afterEach, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { act, render, screen, setupUser, waitFor } from "@/test/react-dom-harness"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "./telemetry"
import { clearActions } from "./context"
import { observeQueryClient, disposeQueryDiagnostics } from "./query-observer"
import { useObservedRegion } from "./regions"
import { startRequest, requestHeaders, readObservedResponse } from "./requests"

vi.mock("next/navigation", () => ({ usePathname: () => "/", useSearchParams: () => new URLSearchParams() }))
const events: Array<{ name: string; attributes: Record<string, string> }> = []
let client: QueryClient
async function emptyResponse() {
  const request = startRequest("/api/community/bots"), response = new Response("[]")
  requestHeaders(request, response)
  return readObservedResponse(response, () => response.json()) as Promise<unknown[]>
}
function Panel({ name }: { name: string }) {
  const resource = useQuery({ queryKey: [name], queryFn: emptyResponse })
  useObservedRegion(name === "active" ? "messages" : "settings", !resource.isPending && resource.data !== undefined, resource.data?.length)
  return <p>{name}: {resource.isPending ? "loading" : "empty"}</p>
}
afterEach(async () => { await act(async () => { retireTelemetry(); clearActions(); disposeQueryDiagnostics(client); client.clear() }) })
it("observes actual settled empty Query values only after a retained Base UI panel becomes visible", async () => {
  events.length = 0
  client = observeQueryClient(new QueryClient())
  configureTelemetry({ session_id: "session-a" }, true)
  installTelemetrySink(event => events.push(event))
  const view = render(<QueryClientProvider client={client}><Tabs defaultValue="active"><TabsList><TabsTrigger value="active">Active</TabsTrigger><TabsTrigger value="retained">Retained</TabsTrigger></TabsList><TabsContent value="active" keepMounted><Panel name="active" /></TabsContent><TabsContent value="retained" keepMounted><Panel name="retained" /></TabsContent></Tabs></QueryClientProvider>)
  await waitFor(() => expect(client.getQueryData(["retained"])).toEqual([]))
  await waitFor(() => expect(events.filter(event => event.name === "region.ready_commit" && event.attributes.region === "messages")).toHaveLength(1))
  expect(events.filter(event => event.name === "region.ready_commit" && event.attributes.region === "settings")).toHaveLength(0)
  const empty = events.find(event => event.name === "region.ready_commit")!
  expect(empty.attributes).toMatchObject({ row_count: "0", outcome: "empty" })
  await setupUser().click(screen.getByRole("tab", { name: "Retained" }))
  await waitFor(() => expect(events.filter(event => event.name === "region.ready_commit" && event.attributes.region === "settings")).toHaveLength(1))
  await act(async () => { view.rerender(<QueryClientProvider client={client}><Tabs defaultValue="active"><TabsList><TabsTrigger value="active">Active</TabsTrigger><TabsTrigger value="retained">Retained</TabsTrigger></TabsList><TabsContent value="active" keepMounted><Panel name="active" /></TabsContent><TabsContent value="retained" keepMounted><Panel name="retained" /></TabsContent></Tabs></QueryClientProvider>) })
  expect(events.filter(event => event.name === "region.ready_commit" && event.attributes.region === "settings")).toHaveLength(1)
})
