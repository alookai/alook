import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiError } from "./errors";

// Mock window globals needed by apiFetch
Object.defineProperty(globalThis, "document", {
  value: { cookie: "" },
  writable: true,
});

// We need to mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Prevent 401 redirect from blowing up
Object.defineProperty(globalThis, "window", {
  value: {
    ...(globalThis.window || {}),
    location: { href: "" },
  },
  writable: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  if (typeof window !== "undefined") {
    window.location.href = "";
  }
});

describe("ApiError class", () => {
  it("constructs with message, status, and details", () => {
    const err = new ApiError("bad request", 400, ["field: required"]);
    expect(err.message).toBe("bad request");
    expect(err.status).toBe(400);
    expect(err.details).toEqual(["field: required"]);
    expect(err.name).toBe("ApiError");
    expect(err).toBeInstanceOf(Error);
  });

  it("isNetworkError returns true for status 0", () => {
    expect(new ApiError("offline", 0).isNetworkError).toBe(true);
    expect(new ApiError("not found", 404).isNetworkError).toBe(false);
  });

  it("isRateLimit returns true for status 429", () => {
    expect(new ApiError("rate limit", 429).isRateLimit).toBe(true);
    expect(new ApiError("bad", 400).isRateLimit).toBe(false);
  });

  it("isUnauthorized returns true for status 401", () => {
    expect(new ApiError("unauth", 401).isUnauthorized).toBe(true);
    expect(new ApiError("ok", 200).isUnauthorized).toBe(false);
  });
});

// We dynamically import to get the patched fetch
async function getApiFetch() {
  // Re-import to pick up mocked fetch
  const mod = await import("./api");
  return mod;
}

describe("apiFetch", () => {
  it("returns ApiError on 400 with { error } JSON body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "name is required" }),
    });

    const { listAgents } = await getApiFetch();
    try {
      await listAgents("w1");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).message).toBe("name is required");
      expect((e as ApiError).status).toBe(400);
    }
  });

  it("propagates details on 400 with details array", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: "validation error",
        details: ["name: required", "email: invalid"],
      }),
    });

    const { listAgents } = await getApiFetch();
    try {
      await listAgents("w1");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).message).toBe("Name is required");
      expect((e as ApiError).details).toEqual(["name: required", "email: invalid"]);
    }
  });

  it("turns validation details into a readable error message", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: "validation error",
        details: ["runtime_id: runtime_id is required"],
      }),
    });

    const { listAgents } = await getApiFetch();
    try {
      await listAgents("w1");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).message).toBe("Runtime Id is required");
      expect((e as ApiError).details).toEqual(["runtime_id: runtime_id is required"]);
    }
  });

  it("returns ApiError with status 0 on network TypeError", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const { listAgents } = await getApiFetch();
    try {
      await listAgents("w1");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(0);
      expect((e as ApiError).message).toBe("Unable to connect — check your network");
      expect((e as ApiError).isNetworkError).toBe(true);
    }
  });

  it("returns ApiError with 'Please wait' on 429", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: "rate limited" }),
    });

    const { listAgents } = await getApiFetch();
    try {
      await listAgents("w1");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(429);
      expect((e as ApiError).message).toBe("Please wait a moment before trying again");
      expect((e as ApiError).isRateLimit).toBe(true);
    }
  });

  it("returns generic message on 500 with non-JSON body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => { throw new Error("not json"); },
    });

    const { listAgents } = await getApiFetch();
    try {
      await listAgents("w1");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(500);
      expect((e as ApiError).message).toBe("Something went wrong — please try again");
    }
  });

  it("uses server error message on 500 with JSON body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "database connection failed" }),
    });

    const { listAgents } = await getApiFetch();
    try {
      await listAgents("w1");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).message).toBe("database connection failed");
    }
  });

  it("returns generic message on 502 with empty body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => { throw new Error("empty"); },
    });

    const { listAgents } = await getApiFetch();
    try {
      await listAgents("w1");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(502);
      expect((e as ApiError).message).toBe("Something went wrong — please try again");
    }
  });

  it("redirects on 401 and throws ApiError", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "unauthorized" }),
    });

    const { listAgents } = await getApiFetch();
    try {
      await listAgents("w1");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(401);
      expect((e as ApiError).message).toBe("Unauthorized");
      expect((e as ApiError).isUnauthorized).toBe(true);
    }
  });
});

describe("conversationInit — message_count serialization", () => {
  function okJson() {
    return { ok: true, status: 200, json: async () => ({}) };
  }

  function lastUrl(): string {
    const call = mockFetch.mock.calls.at(-1);
    return String(call?.[0] ?? "");
  }

  it("omits message_count when the count is 0 (treated as unknown)", async () => {
    mockFetch.mockResolvedValueOnce(okJson());
    const { conversationInit } = await getApiFetch();
    await conversationInit("conv_1", "w1", { messageCount: 0 });
    expect(lastUrl()).not.toContain("message_count");
    // Critically: never sends the truthy string "0", which would make the
    // server's `serverMessageCount === 0` compare fail for non-empty convs.
    expect(lastUrl()).not.toContain("message_count=0");
  });

  it("includes message_count when the count is greater than 0", async () => {
    mockFetch.mockResolvedValueOnce(okJson());
    const { conversationInit } = await getApiFetch();
    await conversationInit("conv_1", "w1", { messageCount: 12 });
    expect(lastUrl()).toContain("message_count=12");
  });

  it("omits message_count when not provided", async () => {
    mockFetch.mockResolvedValueOnce(okJson());
    const { conversationInit } = await getApiFetch();
    await conversationInit("conv_1", "w1");
    expect(lastUrl()).not.toContain("message_count");
  });
});

describe("apiFetch — mock network delay", () => {
  afterEach(() => {
    process.env.NODE_ENV = "test";
    delete process.env.NEXT_PUBLIC_MOCK_NETWORK;
    delete process.env.NEXT_PUBLIC_MOCK_NETWORK_DELAY_MS;
    vi.useRealTimers();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("delays fetch by default 300ms when NEXT_PUBLIC_MOCK_NETWORK is true", async () => {
    vi.useFakeTimers();
    process.env.NODE_ENV = "development";
    process.env.NEXT_PUBLIC_MOCK_NETWORK = "true";
    vi.resetModules();

    const localMockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: "a1" }],
    });
    vi.stubGlobal("fetch", localMockFetch);

    const { listAgents } = await import("./api");
    const promise = listAgents("w1");

    expect(localMockFetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);

    const result = await promise;
    expect(localMockFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ id: "a1" }]);
  });

  it("calls fetch immediately when mock network is disabled", async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const localMockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: "a1" }],
    });
    vi.stubGlobal("fetch", localMockFetch);

    const { listAgents } = await import("./api");
    const promise = listAgents("w1");

    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(localMockFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ id: "a1" }]);
  });

  it("uses custom delay from NEXT_PUBLIC_MOCK_NETWORK_DELAY_MS", async () => {
    vi.useFakeTimers();
    process.env.NODE_ENV = "development";
    process.env.NEXT_PUBLIC_MOCK_NETWORK = "true";
    process.env.NEXT_PUBLIC_MOCK_NETWORK_DELAY_MS = "500";
    vi.resetModules();

    const localMockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: "a1" }],
    });
    vi.stubGlobal("fetch", localMockFetch);

    const { listAgents } = await import("./api");
    const promise = listAgents("w1");

    expect(localMockFetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(localMockFetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    const result = await promise;
    expect(localMockFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ id: "a1" }]);
  });
});

