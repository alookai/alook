import { describe, it, expect, vi, beforeEach } from "vitest";
import { cached, cachedBatch, invalidate, invalidateMany, bindCacheKV, cacheKeys, getKV } from "./cache";

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
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await cached("error-key", 300, fn);

      expect(result).toEqual({ data: "fallback" });
      expect(fn).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[cache] KV read failed for error-key"),
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });

    it("still returns value when KV write throws", async () => {
      (mockKV.put as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("KV write error"));
      const fn = vi.fn(async () => ({ data: "ok" }));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await cached("write-fail-key", 300, fn);

      expect(result).toEqual({ data: "ok" });
      // Wait for async catch handler
      await new Promise((r) => setTimeout(r, 10));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[cache] KV write failed for write-fail-key"),
        expect.any(Error),
      );
      warnSpy.mockRestore();
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
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await invalidate("fail-key");

      await new Promise((r) => setTimeout(r, 10));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[cache] KV delete failed for fail-key"),
        expect.any(Error),
      );
      warnSpy.mockRestore();
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
      expect(cacheKeys.emailAccountsByAgent("ws1", "ag1")).toBe("ea:ws1:ag1");
      expect(cacheKeys.colleaguesByAgent("ws1", "ag1")).toBe("col:ws1:ag1");
      expect(cacheKeys.heartbeat("ws1", "d1")).toBe("hb:ws1:d1");
      expect(cacheKeys.machineToken("al_1234567890abcdefghij_rest")).toBe("mt:al_1234567890abcdefg");
      expect(cacheKeys.machineTokenLastUsed("al_1234567890abcdefghij_rest")).toBe("mt_lu:al_1234567890abcdefg");
      expect(cacheKeys.runtimeIds("ws1", "d1")).toBe("rt:ws1:d1");
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
