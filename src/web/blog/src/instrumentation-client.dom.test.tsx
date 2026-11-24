import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "@/test/react-dom-harness";
import { announceAnalyticsConsent } from "@/lib/analytics-consent";

beforeEach(() => { Reflect.get(globalThis, "jsdom").reconfigure({ url: "https://alook.ai/" }); });

afterEach(async () => {
  await act(async () => {
    document.cookie = "alook_analytics_consent=v1.denied; path=/";
    announceAnalyticsConsent("denied");
  });
  delete window.dataLayer;
  Reflect.deleteProperty(window, "ga-disable-G-STBCL8F4ZY");
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

it.each(["", "v1.denied", "v0.granted", "v1.granted"])("boots the actual Blog document from %s with default public collection and saved denial preserved", async value => {
  vi.resetModules();
  window.history.replaceState(null, "", "/blog/public?secret=query#hash");
  document.cookie = `alook_analytics_consent=${value}; path=/`;
  window.dataLayer = [];
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const { onRouterTransitionStart } = await import("./instrumentation-client");
  expect(window.dataLayer.map(command => Array.from(command as IArguments))).toEqual([
    ["consent", "default", { analytics_storage: value === "v1.denied" ? "denied" : "granted", ad_storage: value === "v1.denied" ? "denied" : "granted", ad_user_data: value === "v1.denied" ? "denied" : "granted", ad_personalization: "denied" }],
    ["set", { page_location: `${window.location.origin}/blog/public`, page_referrer: "" }],
  ]);
  onRouterTransitionStart("/blog/other?secret=route#hash");
  onRouterTransitionStart("/c/me?secret=private");
  expect(window.dataLayer).toHaveLength(3);
  expect(Array.from(window.dataLayer.at(-1) as IArguments)).toEqual(["set", { page_location: `${window.location.origin}/blog/other`, page_referrer: "" }]);
  expect(JSON.stringify(window.dataLayer)).not.toMatch(/secret|page_view/);
  expect(fetcher).not.toHaveBeenCalled();
});


it.each(["http://localhost:3000", "https://preview.alook.test"])("keeps production Google collection disabled on %s in the real Blog entry", async origin => {
  vi.resetModules();
  Reflect.get(globalThis, "jsdom").reconfigure({ url: `${origin}/blog/public?secret=query#hash` });
  document.cookie = "alook_analytics_consent=v1.granted; path=/";
  window.dataLayer = [];
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await import("./instrumentation-client");
  expect(Array.from(window.dataLayer[0] as IArguments)).toEqual(["consent", "default", { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" }]);
  expect(Reflect.get(window, "ga-disable-G-STBCL8F4ZY")).toBe(true);
  expect(JSON.stringify(window.dataLayer)).not.toMatch(/secret|page_view/);
  expect(fetcher).not.toHaveBeenCalled();
});
