import { afterEach, expect, it, vi } from "vitest";
import { initializeFaro, InternalLoggerLevel, SessionInstrumentation, VolatileSessionsManager } from "@grafana/faro-web-sdk";
import { act, render } from "@/test/react-dom-harness";
import { announceAnalyticsConsent } from "@/lib/analytics-consent";

vi.mock("next/navigation", () => ({ usePathname: () => window.location.pathname, useSearchParams: () => new URLSearchParams(window.location.search) }));

afterEach(async () => {
  await act(async () => {
    document.cookie = "alook_analytics_consent=v1.denied; path=/";
    announceAnalyticsConsent("denied");
  });
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

it("boots the actual Blog entry with the native resumed session and exports its router transition through the rendered content owner", async () => {
  vi.useFakeTimers();
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public");
  vi.stubEnv("NEXT_PUBLIC_FARO_ENVIRONMENT", "qa");
  vi.stubEnv("NEXT_PUBLIC_FARO_RELEASE", "a".repeat(40));
  Object.defineProperty(performance, "getEntriesByType", { configurable: true, value: () => [] });
  window.history.replaceState(null, "", "/blog");
  document.cookie = "alook_analytics_consent=v1.granted; path=/";
  VolatileSessionsManager.removeUserSession();
  const priorDocument = initializeFaro({
    isolate: true, preventGlobalExposure: true, internalLoggerLevel: InternalLoggerLevel.OFF,
    app: { name: "alook-web" }, transports: [], instrumentations: [new SessionInstrumentation()],
    sessionTracking: { enabled: true, persistent: false, samplingRate: 1, session: { attributes: { alook_account: "anon" } } },
  })!;
  const prior = VolatileSessionsManager.fetchUserSession()!;
  expect(prior.sessionId).toBe(priorDocument.api.getSession()!.id);
  priorDocument.instrumentations.remove(...priorDocument.instrumentations.instrumentations);
  const sent: Array<{ meta: { sdk: { name: string; version: string }; session: { id: string } }; events?: Array<{ name: string; attributes?: Record<string, string> }> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options?: RequestInit) => { if (options?.body) sent.push(JSON.parse(String(options.body))); return new Response(null, { status: 204 }); }));
  const { onRouterTransitionStart } = await import("./instrumentation-client");
  const { navigationForHref } = await import("@/lib/observability/context");
  const { ObservedStaticContent, ObservedRouteCommit } = await import("@/lib/observability/regions");
  await vi.waitFor(() => expect(sent.some(body => body.events?.some(event => event.name === "session_resume"))).toBe(true), { timeout: 5000 });
  const view = render(<><ObservedStaticContent key="/blog" pathname="/blog" /><ObservedRouteCommit /></>);
  await act(async () => { onRouterTransitionStart("/blog/introducing-alook?private=article-title"); });
  const navigation = navigationForHref("/blog/introducing-alook?private=article-title")!;
  expect(navigation).toBeDefined();
  expect(navigation.done).toBe(false);
  await act(async () => {
    window.history.pushState(null, "", "/blog/introducing-alook?private=article-title");
    view.rerender(<><ObservedStaticContent key="/blog" pathname="/blog" /><ObservedRouteCommit /></>);
  });
  expect(navigation.done).toBe(false);
  await act(async () => {
    view.rerender(<><ObservedStaticContent key="introducing-alook" pathname="/blog/introducing-alook" /><ObservedRouteCommit /></>);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  const exported = sent.flatMap(body => body.events ?? []).filter(event => event.attributes?.action_id === navigation.id);
  expect(exported.map(event => event.name)).toEqual(expect.arrayContaining(["action.start", "navigation.intent", "navigation.commit", "region.read", "region.ready_commit", "action.finish"]));
  expect(exported.filter(event => event.name === "action.finish").map(event => event.attributes?.outcome)).toEqual(["success"]);
  for (const event of exported) expect(event.attributes).toMatchObject({ session_id: prior.sessionId, frontend_surface: "blog", route_template: "/blog/[slug]", navigation_id: navigation.navigationId });
  for (const body of sent) expect(body).toMatchObject({ meta: { sdk: { name: "faro-web", version: "2.12.1" }, session: { id: prior.sessionId } } });
  expect(VolatileSessionsManager.fetchUserSession()).toMatchObject({ sessionId: prior.sessionId, started: prior.started });
  expect(JSON.stringify(sent)).not.toContain("alook_account");
  expect(JSON.stringify(exported)).not.toContain("article-title");
  expect(JSON.stringify(exported)).not.toContain("introducing-alook");
});
