const PUBLIC_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const PUBLIC_CDN_CACHE_CONTROL = "public, s-maxage=3600, stale-while-revalidate=86400";

export function finalizePublicWorkerResponse(
	response: Response,
	cacheable: boolean,
	request: Request,
): Response {
	if (!cacheable || response.status !== 200 || !["GET", "HEAD"].includes(request.method)) return response;
	if (request.headers.has("Cookie") || request.headers.has("Authorization") || request.headers.has("RSC")) return response;
	if (new URL(request.url).searchParams.has("_rsc")) return response;
	if (response.headers.has("Set-Cookie")) return response;
	if (["Cache-Control", "CDN-Cache-Control", "Cloudflare-CDN-Cache-Control"].some((header) => response.headers.has(header))) return response;
	if (response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "text/html") return response;
	const vary = response.headers.get("Vary")?.split(",").map((header) => header.trim().toLowerCase()) ?? [];
	if (vary.some((header) => ["*", "cookie", "authorization", "rsc"].includes(header))) return response;
	const finalized = new Response(response.body, response);
	finalized.headers.set("Cache-Control", PUBLIC_CACHE_CONTROL);
	finalized.headers.set("CDN-Cache-Control", PUBLIC_CDN_CACHE_CONTROL);
	return finalized;
}

export const publicWorkerCacheHeaders = {
	cacheControl: PUBLIC_CACHE_CONTROL,
	cdnCacheControl: PUBLIC_CDN_CACHE_CONTROL,
} as const;
