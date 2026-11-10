import { defineCloudflareConfig, type OpenNextConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import { withRegionalCache } from "@opennextjs/cloudflare/overrides/incremental-cache/regional-cache";
import doQueue from "@opennextjs/cloudflare/overrides/queue/do-queue";
import { observeDownloadCacheReads } from "./src/lib/download-cache-read-observation";

const cloudflare = defineCloudflareConfig({
	incrementalCache: observeDownloadCacheReads(withRegionalCache(r2IncrementalCache, { mode: "long-lived" })),
	queue: doQueue,
	enableCacheInterception: true,
});

export default {
	...cloudflare,
	buildCommand: "pnpm build:next",
} satisfies OpenNextConfig;
