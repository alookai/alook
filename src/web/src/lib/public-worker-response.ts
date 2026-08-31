const PUBLIC_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const PUBLIC_CDN_CACHE_CONTROL = "public, s-maxage=3600, stale-while-revalidate=86400";

export function finalizePublicWorkerResponse(
	response: Response,
	cacheable: boolean,
): Response {
	if (!cacheable || response.status !== 200) return response;
	const finalized = new Response(response.body, response);
	finalized.headers.set("Cache-Control", PUBLIC_CACHE_CONTROL);
	finalized.headers.set("CDN-Cache-Control", PUBLIC_CDN_CACHE_CONTROL);
	return finalized;
}

export const publicWorkerCacheHeaders = {
	cacheControl: PUBLIC_CACHE_CONTROL,
	cdnCacheControl: PUBLIC_CDN_CACHE_CONTROL,
} as const;
