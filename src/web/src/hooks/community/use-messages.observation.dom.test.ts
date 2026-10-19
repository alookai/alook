import { conversationEntryFromChannel } from "@/test/conversation-entry-fixtures"
import { createElement, type PropsWithChildren } from "react"
import { ROOT_CONTEXT, SpanKind, context, trace } from "@opentelemetry/api"
import { InMemorySpanExporter, SimpleSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web"
import { COMMUNITY_CONTRACT_HEADER, COMMUNITY_CONTRACT_VERSION } from "@alook/shared"
import { afterEach, expect, it, vi } from "vitest"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { beginNavigation, clearActions, commitNavigation, finishAction, installActionSpans } from "@/lib/observability/context"
import { observeTransportSpan } from "@/lib/observability/requests"
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "@/lib/observability/telemetry"
import { useDmMessages, useMessages } from "./use-messages"

const providers: WebTracerProvider[] = []

afterEach(async () => {
  retireTelemetry()
  clearActions()
  installActionSpans(undefined)
  await Promise.all(providers.splice(0).map(provider => provider.shutdown()))
  context.disable()
  trace.disable()
  vi.unstubAllGlobals()
  window.history.replaceState(null, "", "/")
})

it.each(["channel", "dm"] as const)("keeps real %s API events and native spans on their captured page across a new commit", async kind => {
  const exporter = new InMemorySpanExporter()
  const provider = new WebTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  providers.push(provider)
  provider.register()
  const tracer = provider.getTracer("alook.frontend")
  configureTelemetry({ session_id: "message-page-owner" }, true)
  const events: Array<{ name: string; attributes: Record<string, string> }> = []
  installTelemetrySink(event => events.push(event))
  installActionSpans((name, attributes, startTime, links, parent) => tracer.startSpan(name, { attributes, startTime, links }, parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT))
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const span = tracer.startSpan("GET messages", { kind: SpanKind.CLIENT })
    observeTransportSpan(span)
    span.end()
    const entry = conversationEntryFromChannel({ id: "channel-a", serverId: kind === "channel" ? "server-a" : null, type: kind === "channel" ? "text" : "dm", name: null, archived: false, createdAt: "2026-10-01T00:00:00Z" })
    return Response.json(new URL(url, "https://example.test").searchParams.has("entry") ? entry : {
      contractVersion: COMMUNITY_CONTRACT_VERSION, channelId: entry.channelId, messages: entry.messages, page: entry.page, surfaceReceipt: entry.surfaceReceipt,
    }, { headers: { [COMMUNITY_CONTRACT_HEADER]: new URL(url, "https://example.test").searchParams.has("entry") ? "3" : String(COMMUNITY_CONTRACT_VERSION) } })

  }))
  const href = kind === "channel" ? "/c/channels/server-a/channel-a" : "/c/me/channel-a"
  window.history.replaceState(null, "", href)
  const owner = beginNavigation(href)!
  commitNavigation(href)
  const { client } = await createCommunityQueryOwner()
  const useSurface = kind === "channel" ? useMessages : useDmMessages
  function wrapper({ children }: PropsWithChildren) {
    return createElement(CommunityTestProvider, { client }, children)
  }
  let rendered!: ReturnType<typeof renderHook<ReturnType<typeof useMessages>, unknown>>
  await act(async () => {
    rendered = renderHook(() => useSurface("channel-a", { serverId: "server-a" }), { wrapper })
  })
  await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true))
  expect(events.find(event => event.name === "request.finish")?.attributes, JSON.stringify(events.find(event => event.name === "request.finish")?.attributes)).toMatchObject({ action_id: owner.id, request_reason: "foreground", outcome: "success" })
  finishAction(owner, "success", { phase: "primary", region: "messages" })
  events.length = 0
  await act(async () => { await rendered.result.current.refetch() })
  expect(events.find(event => event.name === "request.finish")?.attributes, JSON.stringify(events.find(event => event.name === "request.finish")?.attributes)).toMatchObject({ action_id: owner.id, request_reason: "background", outcome: "success" })
  const owned = exporter.getFinishedSpans().filter(span => span.name === "GET messages")
  expect(owned).toHaveLength(2)
  expect(owned.every(span => span.parentSpanContext?.spanId === owner.span!.spanContext().spanId)).toBe(true)
  window.history.replaceState(null, "", "/c/me/bots")
  const next = beginNavigation("/c/me/bots")!
  commitNavigation("/c/me/bots")
  finishAction(next, "success", { phase: "primary", region: "bots" })
  events.length = 0
  await act(async () => { await rendered.result.current.refetch() })
  const request = events.find(event => event.name === "request.finish")!
  expect(request.attributes).toMatchObject({ request_reason: "unknown", outcome: "success" })
  expect(request.attributes).not.toHaveProperty("action_id")
  expect(request.attributes).not.toHaveProperty("navigation_id")
  const unowned = exporter.getFinishedSpans().filter(span => span.name === "GET messages").at(-1)!
  expect(unowned.parentSpanContext).toBeUndefined()
  expect(unowned.spanContext().traceId).not.toBe(owner.span!.spanContext().traceId)
  expect(unowned.spanContext().traceId).not.toBe(next.span!.spanContext().traceId)
  expect(request.attributes.trace_id).toBe(unowned.spanContext().traceId)
})
