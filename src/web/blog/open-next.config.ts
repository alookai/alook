import {
	defineCloudflareConfig,
	type OpenNextConfig,
} from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

const cloudflare = defineCloudflareConfig({
	incrementalCache: staticAssetsIncrementalCache,
	enableCacheInterception: true,
	tagCache: "dummy",
	queue: "direct",
});

export default {
	...cloudflare,
	appPath: "blog",
	buildOutputPath: "blog",
	packageJsonPath: "blog",
	buildCommand: "pnpm --dir .. build:blog:next",
	dangerous: {
		...cloudflare.dangerous,
		disableTagCache: true,
	},
} satisfies OpenNextConfig;
