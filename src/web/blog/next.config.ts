import createMDX from "@next/mdx";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const { blogMdxOptions } = createRequire(path.resolve(__dirname, "next.config.ts"))("./mdx-options.ts") as typeof import("./mdx-options");

const blogRedirectRules = JSON.parse(
	readFileSync(path.resolve(__dirname, "src/lib/blog/redirects.json"), "utf8"),
) as Array<{ source: string; destination: string; statusCode: 301 }>;
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
const { resolveObservationBuild } = createRequire(path.resolve(__dirname, "next.config.ts"))("../src/lib/observability/build.ts") as typeof import("@/lib/observability/build");
const observation = resolveObservationBuild(process.env);

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    NEXT_PUBLIC_FARO_RELEASE: observation.release ?? "",
    NEXT_PUBLIC_FARO_ENVIRONMENT: observation.environment ?? "",
  },
	assetPrefix: "/blog-static",
	images: { unoptimized: true },
	pageExtensions: ["js", "jsx", "md", "mdx", "ts", "tsx"],
	turbopack: {
		root: path.resolve(__dirname, "../../.."),
	},
	async redirects() {
		return blogRedirectRules;
	},
};

const withMDX = createMDX({ options: blogMdxOptions });

export default async function blogConfig() {
	const { prepareBlogImages } = createRequire(path.resolve(__dirname, "next.config.ts"))("./scripts/prepare-images.mjs");
	await prepareBlogImages(__dirname);
	return withMDX(nextConfig);
}

initOpenNextCloudflareForDev({
	configPath: path.resolve(__dirname, "wrangler.toml"),
});
