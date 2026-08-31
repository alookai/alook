import {
	defineCloudflareConfig,
	type OpenNextConfig,
} from "@opennextjs/cloudflare";

const cloudflare = defineCloudflareConfig({
	incrementalCache: "dummy",
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
		disableIncrementalCache: true,
		disableTagCache: true,
	},
} satisfies OpenNextConfig;
