import type { NextConfig } from "next";
import path from "node:path";
import createMDX from "@next/mdx";

const nextConfig: NextConfig = {
	// Prevent the bundler from creating duplicate copies of @better-auth/core,
	// which breaks AsyncLocalStorage-based request state (dual module hazard).
	// See: https://www.better-auth.com/docs/reference/faq#troubleshooting
	serverExternalPackages: ["@better-auth/core"],
	turbopack: {
		root: path.resolve(__dirname, "../.."),
	},
	pageExtensions: ["js", "jsx", "md", "mdx", "ts", "tsx"],
};

const withMDX = createMDX({
	options: {
		remarkPlugins: [],
		rehypePlugins: [
			["rehype-pretty-code", { theme: { light: "vitesse-light", dark: "vitesse-dark" }, keepBackground: false }],
		],
	},
});

export default withMDX(nextConfig);

// Enable calling `getCloudflareContext()` in `next dev`.
// See https://opennext.js.org/cloudflare/bindings#local-access-to-bindings.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
