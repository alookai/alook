import { getCloudflareContext } from "@opennextjs/cloudflare"
import { resolveMode } from "@alook/shared"

function getPackageName(): string {
  try {
    const { env } = getCloudflareContext()
    const mode = resolveMode({ nodeEnv: (env as unknown as Record<string, unknown>).NODE_ENV as string | undefined })
    if (mode !== "production") return "@alook/app"
  } catch {}
  return "@alook/cli"
}

async function fetchLatestPackageVersion(pkg: string): Promise<{ version: string; package: string } | null> {
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

export function fetchLatestCliVersion(): Promise<{ version: string; package: string } | null> {
  return fetchLatestPackageVersion(getPackageName())
}

export function fetchLatestDaemonVersion(): Promise<{ version: string; package: string } | null> {
  return fetchLatestPackageVersion("@alook/daemon")
}
