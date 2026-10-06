import { describe, expect, it } from "vitest";
import { finalizePublicWorkerResponse, publicWorkerCacheHeaders } from "./public-worker-response";

const request = new Request("https://worker.test/pricing");
const html = (headers: Record<string, string> = {}, status = 200) => new Response("public page", {
	status,
	headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
});

describe("finalizePublicWorkerResponse", () => {
	it.each(["GET", "HEAD"])("adds the fallback policy to eligible %s documents", async (method) => {
		const response = html({ ETag: '"page-v1"' });
		const result = finalizePublicWorkerResponse(response, true, new Request(request, { method }));
		expect(result.headers.get("Cache-Control")).toBe(publicWorkerCacheHeaders.cacheControl);
		expect(result.headers.get("CDN-Cache-Control")).toBe(publicWorkerCacheHeaders.cdnCacheControl);
		expect(result.headers.get("ETag")).toBe('"page-v1"');
		expect(result.body).toBe(response.body);
		expect(await result.text()).toBe("public page");
	});

	it("leaves ineligible routes untouched", () => {
		const response = html();
		expect(finalizePublicWorkerResponse(response, false, request)).toBe(response);
	});

	it.each([201, 204, 301, 304, 401, 404, 500])("leaves status %s untouched", (status) => {
		const response = new Response(null, { status, headers: { "Content-Type": "text/html" } });
		expect(finalizePublicWorkerResponse(response, true, request)).toBe(response);
	});

	it.each([
		["Cache-Control", "private, no-cache, no-store, max-age=0, must-revalidate"],
		["Cache-Control", "public, max-age=0, must-revalidate"],
		["Cache-Control", "public, max-age=300"],
		["Cache-Control", "public, max-age=31536000, immutable"],
		["CDN-Cache-Control", "no-store"],
		["Cloudflare-CDN-Cache-Control", "no-cache"],
	])("preserves upstream %s: %s", (name, value) => {
		const response = html({ [name]: value });
		expect(finalizePublicWorkerResponse(response, true, request)).toBe(response);
		expect(response.headers.get(name)).toBe(value);
	});

	it.each([
		["Cookie", "session=opaque"],
		["Authorization", "Bearer opaque"],
		["RSC", "1"],
	])("does not broaden requests carrying %s", (name, value) => {
		const response = html();
		expect(finalizePublicWorkerResponse(response, true, new Request(request, { headers: { [name]: value } }))).toBe(response);
	});

	it("does not broaden an RSC query variant", () => {
		const response = html();
		expect(finalizePublicWorkerResponse(response, true, new Request(request.url + "?_rsc=variant"))).toBe(response);
	});

	it("preserves session cookie responses", () => {
		const response = html({ "Set-Cookie": "session=opaque; HttpOnly" });
		expect(finalizePublicWorkerResponse(response, true, request)).toBe(response);
	});

	it.each(["*", "Cookie", "Accept-Encoding, Authorization", "RSC, Next-Router-State-Tree"])("respects Vary %s", (vary) => {
		const response = html({ Vary: vary });
		expect(finalizePublicWorkerResponse(response, true, request)).toBe(response);
	});

	it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("does not cache %s", (method) => {
		const response = html();
		expect(finalizePublicWorkerResponse(response, true, new Request(request, { method }))).toBe(response);
	});

	it.each(["image/webp", "application/javascript", "text/css", "text/x-component", "application/json"])("preserves %s responses", (contentType) => {
		const response = new Response("bytes", { headers: { "Content-Type": contentType } });
		expect(finalizePublicWorkerResponse(response, true, request)).toBe(response);
	});
});
