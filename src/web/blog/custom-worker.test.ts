import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ openNextFetch: vi.fn() }));

vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class<Env> {
		protected ctx: ExecutionContext;
		protected env: Env;

		constructor(ctx: ExecutionContext, env: Env) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

vi.mock("./.open-next/worker.js", () => ({
	default: { fetch: mocks.openNextFetch },
}));

import BlogWorker from "./custom-worker";

describe("Blog Worker entrypoint", () => {
	let worker: BlogWorker;

	beforeEach(() => {
		mocks.openNextFetch.mockReset();
		mocks.openNextFetch.mockImplementation(async (request: Request) => {
			if (new URL(request.url).pathname === "/internal/blog-discovery") {
				return Response.json({ version: 1, posts: [] });
			}
			return new Response("node-open-next", { headers: { "x-open-next": "node-stub" } });
		});
		worker = new BlogWorker({} as ExecutionContext, { ASSETS: {} as Fetcher });
	});

	it("delegates public fetches and finalizes cache headers", async () => {
		const response = await worker.fetch(new Request("https://alook.ai/blog"));
		expect(await response.text()).toBe("node-open-next");
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
	});

	it("denies the internal manifest over HTTP", async () => {
		const response = await worker.fetch(new Request("https://alook.ai/internal/blog-discovery"));
		expect(response.status).toBe(404);
	});

	it("returns the active static manifest over RPC", async () => {
		await expect(worker.getDiscoveryManifest()).resolves.toEqual({ version: 1, posts: [] });
	});

	it("fails when the internal discovery route is unavailable", async () => {
		mocks.openNextFetch.mockResolvedValueOnce(new Response("missing", { status: 503 }));

		await expect(worker.getDiscoveryManifest()).rejects.toThrow("returned 503");
	});
});
