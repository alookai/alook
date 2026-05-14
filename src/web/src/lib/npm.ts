import { getCloudflareContext } from "@opennextjs/cloudflare"

// In local mode (@alook/app), check @alook/app on npm.
// In cloud mode, check @alook/cli.
// Both packages are in the same monorepo and version-bumped together,
// so the daemon's reported cli_version will match either package.
function getPackageName(): string {
  try {
    const { env } = getCloudflareContext()
    if ((env as unknown as Record<string, unknown>).NODE_ENV === "development") return "@alook/app"
  } catch {}
  return "@alook/cli"
}

export async function fetchLatestCliVersion(): Promise<{ version: string; package: string } | null> {
  const pkg = getPackageName()
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    if (!data.version) return null;
    return { version: data.version, package: pkg };
  } catch {
    return null;
  }
}
