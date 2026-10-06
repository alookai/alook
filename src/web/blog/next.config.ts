import createMDX from "@next/mdx";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import path from "node:path";

const blogRedirectRules = JSON.parse(
	readFileSync(path.resolve(__dirname, "src/lib/blog/redirects.json"), "utf8"),
) as Array<{ source: string; destination: string; statusCode: 301 }>;

const nextConfig: NextConfig = {
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

const withMDX = createMDX({
	options: {
		remarkPlugins: ["remark-gfm"],
		rehypePlugins: [
			"rehype-slug",
			["rehype-autolink-headings", { behavior: "wrap" }],
			["rehype-external-links", { target: "_blank", rel: ["noopener", "noreferrer"] }],
			["rehype-pretty-code", { theme: { light: "vitesse-light", dark: "vitesse-dark" }, keepBackground: false }],
		],
	},
});

export default withMDX(nextConfig);

initOpenNextCloudflareForDev({
	configPath: path.resolve(__dirname, "wrangler.toml"),
});
