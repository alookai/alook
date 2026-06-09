import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { captureRegistrationSource, sendRegistrationSource } from "./registration-source";

describe("registration-source", () => {
  const mockFetch = vi.fn();
  const store: Record<string, string> = {};

  function resetStore() {
    for (const key of Object.keys(store)) delete store[key];
  }

  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();

    Object.defineProperty(globalThis, "window", {
      value: { location: { search: "" } },
      writable: true,
      configurable: true,
    });

    Object.defineProperty(globalThis, "document", {
      value: { referrer: "" },
      writable: true,
      configurable: true,
    });

    Object.defineProperty(globalThis, "sessionStorage", {
      value: {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => { store[key] = value; },
        removeItem: (key: string) => { delete store[key]; },
      },
      writable: true,
      configurable: true,
    });

    globalThis.fetch = mockFetch as any;
    mockFetch.mockResolvedValue(new Response("ok"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("captureRegistrationSource", () => {
    it("captures UTM params from URL", () => {
      (window as any).location.search =
        "?utm_source=google&utm_medium=cpc&utm_campaign=launch";

      captureRegistrationSource();

      const stored = JSON.parse(
        store["alook_registration_source"]
      );
      expect(stored).toEqual({
        utm_source: "google",
        utm_medium: "cpc",
        utm_campaign: "launch",
        referrer: null,
      });
    });

    it("captures document.referrer", () => {
      (document as any).referrer = "https://news.ycombinator.com";

      captureRegistrationSource();

      const stored = JSON.parse(
        store["alook_registration_source"]
      );
      expect(stored.referrer).toBe("https://news.ycombinator.com");
    });

    it("captures both UTM and referrer", () => {
      (window as any).location.search = "?utm_source=twitter";
      (document as any).referrer = "https://t.co/abc";

      captureRegistrationSource();

      const stored = JSON.parse(
        store["alook_registration_source"]
      );
      expect(stored.utm_source).toBe("twitter");
      expect(stored.referrer).toBe("https://t.co/abc");
    });

    it("does not store when no UTM or referrer present", () => {
      (window as any).location.search = "";
      (document as any).referrer = "";

      captureRegistrationSource();

      expect(store["alook_registration_source"]).toBeUndefined();
    });

    it("stores null for absent UTM fields", () => {
      (window as any).location.search = "?utm_source=google";

      captureRegistrationSource();

      const stored = JSON.parse(
        store["alook_registration_source"]
      );
      expect(stored.utm_medium).toBeNull();
      expect(stored.utm_campaign).toBeNull();
    });
  });

  describe("sendRegistrationSource", () => {
    it("sends stored data and removes from sessionStorage", () => {
      store["alook_registration_source"] = JSON.stringify({
        utm_source: "google",
        utm_medium: null,
        utm_campaign: null,
        referrer: "https://google.com",
      });

      sendRegistrationSource();

      expect(mockFetch).toHaveBeenCalledWith("/api/user/registration-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          utm_source: "google",
          utm_medium: null,
          utm_campaign: null,
          referrer: "https://google.com",
        }),
        keepalive: true,
      });
      expect(store["alook_registration_source"]).toBeUndefined();
    });

    it("does nothing when no stored data", () => {
      resetStore();

      sendRegistrationSource();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("does not throw on fetch failure", () => {
      store["alook_registration_source"] = JSON.stringify({
        utm_source: "test",
      });
      mockFetch.mockRejectedValue(new Error("network error"));

      expect(() => sendRegistrationSource()).not.toThrow();
    });
  });
});
