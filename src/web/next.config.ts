import type { NextConfig } from "next";
import path from "node:path";
import { readFileSync } from "node:fs";
import { withSerwist } from "@serwist/turbopack";
import { resolveObservationBuild } from "./src/lib/observability/build";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8"));
const daemonPkg = JSON.parse(readFileSync(path.resolve(__dirname, "../daemon/package.json"), "utf-8"));
const observation = resolveObservationBuild(process.env);
const buildId = process.env.ALOOK_WEB_BUILD_ID;

const nextConfig: NextConfig = {
  generateBuildId: async () => {
    if (!buildId || !/^[a-zA-Z0-9_-]+$/.test(buildId)) throw new Error("Use pnpm build:next to produce the Web build identity");
    return buildId;
  },
  experimental: { turbopackFileSystemCacheForDev: false },
  async headers() {
    return [{ source: "/community-shell/:hash", headers: [
      { key: "Cache-Control", value: "public, max-age=31536000, immutable, no-transform" },
      { key: "Content-Type", value: "text/html; charset=utf-8" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Robots-Tag", value: "noindex" },
    ] }];
  },
	images: { unoptimized: true },
	env: {
		NEXT_PUBLIC_APP_VERSION: pkg.version,
		NEXT_PUBLIC_WEB_BUILD_ID: buildId ?? "development",
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
