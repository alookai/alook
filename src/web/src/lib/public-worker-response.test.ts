import { describe, expect, it } from "vitest";
import { finalizePublicWorkerResponse, publicWorkerCacheHeaders } from "./public-worker-response";

describe("finalizePublicWorkerResponse", () => {
	it("preserves the public cache policy", () => {
		const response = finalizePublicWorkerResponse(new Response("ok"), true);
		expect(response.headers.get("Cache-Control")).toBe(publicWorkerCacheHeaders.cacheControl);
		expect(response.headers.get("CDN-Cache-Control")).toBe(publicWorkerCacheHeaders.cdnCacheControl);
	});

	it("does not cache private or unsuccessful responses", () => {
		expect(finalizePublicWorkerResponse(new Response("ok"), false).headers.get("Cache-Control")).toBeNull();
		expect(finalizePublicWorkerResponse(new Response("no", { status: 404 }), true).headers.get("Cache-Control")).toBeNull();
	});
});
