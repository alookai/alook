import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import r2 from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import { withRegionalCache } from "@opennextjs/cloudflare/overrides/incremental-cache/regional-cache";

const pending: Promise<unknown>[] = [];
const value = { type: "app" as const, html: "<h1>public</h1>", rsc: "rsc-payload", revalidate: false as const };
const entry = { value, lastModified: 1_000 };
let entries: Map<string, Response>;
beforeEach(() => {
  entries = new Map();
  pending.length = 0;
  vi.stubGlobal(Symbol.for("__cloudflare-context__"), { ctx: { waitUntil: (task: Promise<unknown>) => pending.push(task) } });
  vi.stubGlobal("nextVersion", "16.4.1");
  vi.stubEnv("OPEN_NEXT_BUILD_ID", "build-a");
  vi.stubGlobal("caches", { open: async () => ({
    match: async (key: string) => entries.get(key)?.clone(),
    put: async (key: string, response: Response) => { entries.set(key, response.clone()); },
    delete: async (key: string) => entries.delete(key),
  }) });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("configured regional incremental cache", () => {
  it("serves a warm page while the backing refresh is still pending, retaining HTML/RSC and tag checks", async () => {
    const get = vi.spyOn(r2, "get").mockResolvedValue(entry);
    const cache = withRegionalCache(r2, { mode: "long-lived" });
    expect(await cache.get("/pricing")).toEqual(entry);
    await Promise.all(pending.splice(0));
    let finish!: (result: typeof entry) => void;
    get.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const warm = await cache.get("/pricing");
    expect(warm).toEqual({ ...entry, shouldBypassTagCache: false });
    expect(pending).toHaveLength(1);
    finish(entry);
    await Promise.all(pending.splice(0));
  });
  it("isolates deployment builds and preserves backing-store writes", async () => {
    const get = vi.spyOn(r2, "get").mockResolvedValue(entry);
    const set = vi.spyOn(r2, "set").mockResolvedValue();
    const cache = withRegionalCache(r2, { mode: "long-lived" });
    await cache.get("/pricing");
    await Promise.all(pending.splice(0));
    vi.stubEnv("OPEN_NEXT_BUILD_ID", "build-b");
    await cache.get("/pricing");
    expect(get).toHaveBeenCalledTimes(2);
    await Promise.all(pending.splice(0));
    expect(entries.size).toBe(2);
    await cache.set("/pricing", value);
    expect(set).toHaveBeenCalledWith("/pricing", value, undefined);
  });
  it("does not invent entries for missing pages", async () => {
    vi.spyOn(r2, "get").mockResolvedValue(null);
    const cache = withRegionalCache(r2, { mode: "long-lived" });
    expect(await cache.get("/missing")).toBeNull();
    expect(entries.size).toBe(0);
  });
});
