import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
	turbopack: {
		root: path.resolve(__dirname, "../.."),
	},
};

export default nextConfig;

// Enable calling `getCloudflareContext()` in `next dev`.
// See https://opennext.js.org/cloudflare/bindings#local-access-to-bindings.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
