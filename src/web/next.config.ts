import type { NextConfig } from "next";
import path from "node:path";
import { readFileSync } from "node:fs";
import { withSerwist } from "@serwist/turbopack";
import { resolveObservationBuild } from "./src/lib/observability/build";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8"));
const daemonPkg = JSON.parse(readFileSync(path.resolve(__dirname, "../daemon/package.json"), "utf-8"));
const observation = resolveObservationBuild(process.env);

const nextConfig: NextConfig = {
	images: { unoptimized: true },
	env: {
		NEXT_PUBLIC_APP_VERSION: pkg.version,
		NEXT_PUBLIC_LATEST_DAEMON_VERSION: daemonPkg.version,
		NEXT_PUBLIC_FARO_RELEASE: observation.release ?? "",
		NEXT_PUBLIC_FARO_ENVIRONMENT: observation.environment ?? "",
	},
	// Prevent the bundler from creating duplicate copies of @better-auth/core,
	// which breaks AsyncLocalStorage-based request state (dual module hazard).
	// See: https://www.better-auth.com/docs/reference/faq#troubleshooting
	serverExternalPackages: ["@better-auth/core"],
	turbopack: {
		root: path.resolve(__dirname, "../.."),
	},
};

export default withSerwist(nextConfig);

// Enable calling `getCloudflareContext()` in `next dev`.
// See https://opennext.js.org/cloudflare/bindings#local-access-to-bindings.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
