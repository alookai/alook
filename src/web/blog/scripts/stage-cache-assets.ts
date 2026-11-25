import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function stageBlogCacheAssets(outputDir: string): void {
	const source = resolve(outputDir, "cache");
	if (!existsSync(source) || readdirSync(source).length === 0) {
		throw new Error("Blog build has no prerendered cache to stage");
	}
	const destination = resolve(outputDir, "assets/cdn-cgi/_next_cache");
	rmSync(destination, { recursive: true, force: true });
	cpSync(source, destination, { recursive: true });
}

export function stageBlogPrefixedStaticAssets(outputDir: string): void {
	const source = resolve(outputDir, "assets/_next/static");
	if (!existsSync(source) || readdirSync(source).length === 0) {
		throw new Error("Blog build has no Next static assets to stage");
	}
	const destination = resolve(outputDir, "assets/blog-static/_next/static");
	rmSync(destination, { recursive: true, force: true });
	cpSync(source, destination, { recursive: true });
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
	const outputDir = resolve(dirname(scriptPath), "../.open-next");
	stageBlogCacheAssets(outputDir);
	stageBlogPrefixedStaticAssets(outputDir);
	console.log("Staged Blog prerendered cache and prefixed static assets for Workers Static Assets.");
}
