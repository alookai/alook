import { describe, it, expect, vi, beforeEach } from "vitest";
import { cached, cachedBatch, invalidate, invalidateMany, bindCacheKV, cacheKeys, getKV, throttled } from "./cache";

function createMockKV() {
  const store = new Map<string, { value: string; expiration?: number }>();
  return {
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, { value, expiration: opts?.expirationTtl });
    }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, { value: string; expiration?: number }> };
}

describe("cache", () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    bindCacheKV(mockKV);
  });

  describe("cached()", () => {
    it("returns cached value on KV hit", async () => {
      mockKV._store.set("test-key", { value: JSON.stringify({ data: "from-kv" }) });
      const fn = vi.fn(async () => ({ data: "from-db" }));

      const result = await cached("test-key", 300, fn);

      expect(result).toEqual({ data: "from-kv" });
      expect(fn).not.toHaveBeenCalled();
    });

    it("calls fn and stores to KV on cache miss", async () => {
      const fn = vi.fn(async () => ({ data: "from-db" }));

      const result = await cached("miss-key", 600, fn);

      expect(result).toEqual({ data: "from-db" });
      expect(fn).toHaveBeenCalledOnce();
      expect(mockKV.put).toHaveBeenCalledWith(
        "miss-key",
        JSON.stringify({ data: "from-db" }),
        { expirationTtl: 600 },
      );
    });

    it("falls back to fn when KV read throws", async () => {
      (mockKV.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("KV down"));
      const fn = vi.fn(async () => ({ data: "fallback" }));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await cached("error-key", 300, fn);

      expect(result).toEqual({ data: "fallback" });
      expect(fn).toHaveBeenCalledOnce();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('"msg":"KV read failed"'),
      );
      logSpy.mockRestore();
    });

    it("still returns value when KV write throws", async () => {
      (mockKV.put as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("KV write error"));
      const fn = vi.fn(async () => ({ data: "ok" }));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await cached("write-fail-key", 300, fn);

      expect(result).toEqual({ data: "ok" });
      await new Promise((r) => setTimeout(r, 10));
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('"msg":"KV write failed"'),
      );
      logSpy.mockRestore();
    });

    it("clamps TTL to minimum 60s for KV write", async () => {
      const fn = vi.fn(async () => "val");

      await cached("ttl-key", 5, fn);

      expect(mockKV.put).toHaveBeenCalledWith(
        "ttl-key",
        JSON.stringify("val"),
        { expirationTtl: 60 },
      );
    });

    it("does not store null values to KV", async () => {
      const fn = vi.fn(async () => null);

      const result = await cached("null-key", 300, fn as () => Promise<unknown>);

      expect(result).toBeNull();
      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it("falls back to fn when KV is not bound", async () => {
      bindCacheKV(null);
      const fn = vi.fn(async () => ({ data: "no-kv" }));

      const result = await cached("no-kv-key", 300, fn);

      expect(result).toEqual({ data: "no-kv" });
      expect(fn).toHaveBeenCalledOnce();
    });
  });

  describe("cachedBatch()", () => {
    it("returns all from KV on full cache hit", async () => {
      mockKV._store.set("k1", { value: JSON.stringify("v1") });
      mockKV._store.set("k2", { value: JSON.stringify("v2") });
      const fetchMissing = vi.fn();

      const result = await cachedBatch(["k1", "k2"], 300, fetchMissing);

      expect(result.get("k1")).toBe("v1");
      expect(result.get("k2")).toBe("v2");
      expect(fetchMissing).not.toHaveBeenCalled();
    });

    it("fetches missing keys from D1 and stores in KV", async () => {
      mockKV._store.set("k1", { value: JSON.stringify("cached") });
      const fetchMissing = vi.fn(async (keys: string[]) => {
        const m = new Map<string, string>();
        for (const k of keys) m.set(k, `fetched-${k}`);
        return m;
      });

      const result = await cachedBatch(["k1", "k2", "k3"], 300, fetchMissing);

      expect(result.get("k1")).toBe("cached");
      expect(result.get("k2")).toBe("fetched-k2");
      expect(result.get("k3")).toBe("fetched-k3");
      expect(fetchMissing).toHaveBeenCalledWith(["k2", "k3"]);
      expect(mockKV.put).toHaveBeenCalledTimes(2);
    });

    it("falls back to full D1 fetch when KV throws", async () => {
      (mockKV.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("KV down"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMissing = vi.fn(async (keys: string[]) => {
        const m = new Map<string, string>();
        for (const k of keys) m.set(k, `db-${k}`);
        return m;
      });

      const result = await cachedBatch(["k1", "k2"], 300, fetchMissing);

      expect(result.get("k1")).toBe("db-k1");
      expect(result.get("k2")).toBe("db-k2");
      expect(fetchMissing).toHaveBeenCalledWith(["k1", "k2"]);
      warnSpy.mockRestore();
    });

    it("returns empty map for empty keys", async () => {
      const fetchMissing = vi.fn();
      const result = await cachedBatch([], 300, fetchMissing);
      expect(result.size).toBe(0);
      expect(fetchMissing).not.toHaveBeenCalled();
    });
  });

  describe("invalidate()", () => {
    it("deletes key from KV", async () => {
      mockKV._store.set("del-key", { value: "x" });
      await invalidate("del-key");
      expect(mockKV.delete).toHaveBeenCalledWith("del-key");
    });

    it("logs warning on KV delete failure", async () => {
      (mockKV.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("fail"));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await invalidate("fail-key");

      await new Promise((r) => setTimeout(r, 10));
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('"msg":"KV invalidate failed"'),
      );
      logSpy.mockRestore();
    });

    it("does nothing when KV is not bound", async () => {
      bindCacheKV(null);
      await invalidate("no-kv-key");
      expect(mockKV.delete).not.toHaveBeenCalled();
    });
  });

  describe("invalidateMany()", () => {
    it("deletes all specified keys", async () => {
      await invalidateMany(["k1", "k2", "k3"]);
      expect(mockKV.delete).toHaveBeenCalledTimes(3);
      expect(mockKV.delete).toHaveBeenCalledWith("k1");
      expect(mockKV.delete).toHaveBeenCalledWith("k2");
      expect(mockKV.delete).toHaveBeenCalledWith("k3");
    });

    it("does not throw when some deletes fail", async () => {
      (mockKV.delete as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValueOnce(undefined);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await invalidateMany(["k1", "k2", "k3"]);

      expect(mockKV.delete).toHaveBeenCalledTimes(3);
      warnSpy.mockRestore();
    });

    it("handles empty keys array", async () => {
      await invalidateMany([]);
      expect(mockKV.delete).not.toHaveBeenCalled();
    });
  });

  describe("cacheKeys", () => {
    it("generates correct key formats", () => {
      expect(cacheKeys.agent("ws1", "ag1")).toBe("ag:ws1:ag1");
      expect(cacheKeys.member("ws1", "usr1")).toBe("mem:ws1:usr1");
      expect(cacheKeys.user("usr1")).toBe("usr:usr1");
      expect(cacheKeys.allEmailAccounts("ws1")).toBe("ea:ws1");
      expect(cacheKeys.allColleagues("ws1")).toBe("col:ws1");
      expect(cacheKeys.allAgents("ws1")).toBe("agents:ws1");
      expect(cacheKeys.allHandles("ws1")).toBe("handles:ws1");
      expect(cacheKeys.heartbeat("ws1", "d1")).toBe("hb:ws1:d1");
      expect(cacheKeys.machineToken("al_1234567890abcdefghij_rest")).toBe("mt:al_1234567890abcdefg");
      expect(cacheKeys.machineTokenLastUsed("al_1234567890abcdefghij_rest")).toBe("mt_lu:al_1234567890abcdefg");
      expect(cacheKeys.runtimeIds("ws1", "d1")).toBe("rt:ws1:d1");
    });

    it("generates correct new cache key formats", () => {
      expect(cacheKeys.overviewEmailStats("ws1")).toBe("ov_email:ws1");
      expect(cacheKeys.overviewTaskStats("ws1", "2026-05-18")).toBe("ov_task:ws1:2026-05-18");
      expect(cacheKeys.allAgentAccess("ws1")).toBe("aa:ws1");
      expect(cacheKeys.allRuntimes("ws1")).toBe("runtimes:ws1");
      expect(cacheKeys.allMembers("ws1")).toBe("members:ws1");
    });

    it("workspace-scoped keys differ by workspace", () => {
      expect(cacheKeys.overviewEmailStats("ws1")).not.toBe(cacheKeys.overviewEmailStats("ws2"));
      expect(cacheKeys.allRuntimes("ws1")).not.toBe(cacheKeys.allRuntimes("ws2"));
      expect(cacheKeys.allMembers("ws1")).not.toBe(cacheKeys.allMembers("ws2"));
      expect(cacheKeys.allAgentAccess("ws1")).not.toBe(cacheKeys.allAgentAccess("ws2"));
    });

    it("no collisions between new key types for same workspace", () => {
      const ws = "ws_collision_test";
      const keys = new Set([
        cacheKeys.overviewEmailStats(ws),
        cacheKeys.overviewTaskStats(ws, "2026-01-01"),
        cacheKeys.allAgentAccess(ws),
        cacheKeys.allRuntimes(ws),
        cacheKeys.allMembers(ws),
        cacheKeys.allAgents(ws),
        cacheKeys.allEmailAccounts(ws),
        cacheKeys.allColleagues(ws),
        cacheKeys.allHandles(ws),
      ]);
      expect(keys.size).toBe(9);
    });

    it("overviewTaskStats includes date for cross-midnight isolation", () => {
      expect(cacheKeys.overviewTaskStats("ws1", "2026-05-17")).not.toBe(
        cacheKeys.overviewTaskStats("ws1", "2026-05-18"),
      );
    });
  });

  describe("throttled()", () => {
    it("runs fn on first call (no prior timestamp)", async () => {
      const fn = vi.fn(async () => {});
      const ran = await throttled("thr-key", 5, fn);
      expect(ran).toBe(true);
      expect(fn).toHaveBeenCalledOnce();
      expect(mockKV.put).toHaveBeenCalledWith(
        "thr-key",
        expect.stringMatching(/^\d+$/),
        { expirationTtl: 60 },
      );
    });

    it("skips fn when within throttle interval", async () => {
      mockKV._store.set("thr-key", { value: String(Date.now()) });
      const fn = vi.fn(async () => {});
      const ran = await throttled("thr-key", 5, fn);
      expect(ran).toBe(false);
      expect(fn).not.toHaveBeenCalled();
    });

    it("runs fn when throttle interval has elapsed", async () => {
      mockKV._store.set("thr-key", { value: String(Date.now() - 6000) });
      const fn = vi.fn(async () => {});
      const ran = await throttled("thr-key", 5, fn);
      expect(ran).toBe(true);
      expect(fn).toHaveBeenCalledOnce();
    });

    it("runs fn when KV is not bound", async () => {
      bindCacheKV(null);
      const fn = vi.fn(async () => {});
      const ran = await throttled("thr-key", 5, fn);
      expect(ran).toBe(true);
      expect(fn).toHaveBeenCalledOnce();
    });

    it("runs fn when KV read fails", async () => {
      (mockKV.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("KV down"));
      const fn = vi.fn(async () => {});
      const ran = await throttled("thr-key", 5, fn);
      expect(ran).toBe(true);
      expect(fn).toHaveBeenCalledOnce();
    });
  });

  describe("KV complete failure scenario", () => {
    it("all operations gracefully degrade when KV is entirely down", async () => {
      const brokenKV = {
        get: vi.fn().mockRejectedValue(new Error("503 Service Unavailable")),
        put: vi.fn().mockRejectedValue(new Error("503 Service Unavailable")),
        delete: vi.fn().mockRejectedValue(new Error("503 Service Unavailable")),
      } as unknown as KVNamespace;
      bindCacheKV(brokenKV);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // cached() should fall through to fn
      const result = await cached("key", 300, async () => "db-value");
      expect(result).toBe("db-value");

      // cachedBatch() should fetch all from D1
      const batchResult = await cachedBatch(
        ["k1", "k2"],
        300,
        async (keys) => new Map(keys.map((k) => [k, `val-${k}`])),
      );
      expect(batchResult.get("k1")).toBe("val-k1");
      expect(batchResult.get("k2")).toBe("val-k2");

      // invalidate() should not throw
      await expect(invalidate("key")).resolves.toBeUndefined();
      await expect(invalidateMany(["k1", "k2"])).resolves.toBeUndefined();

      warnSpy.mockRestore();
    });
  });
});
