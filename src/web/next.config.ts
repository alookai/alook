import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
	// Prevent the bundler from creating duplicate copies of @better-auth/core,
	// which breaks AsyncLocalStorage-based request state (dual module hazard).
	// See: https://www.better-auth.com/docs/reference/faq#troubleshooting
	serverExternalPackages: ["better-auth", "@better-auth/core"],
	turbopack: {
		root: path.resolve(__dirname, "../.."),
	},
};

export default nextConfig;

// Enable calling `getCloudflareContext()` in `next dev`.
// See https://opennext.js.org/cloudflare/bindings#local-access-to-bindings.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
