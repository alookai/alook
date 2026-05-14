import { getCloudflareContext } from "@opennextjs/cloudflare"

function getPackageName(): string {
  try {
    const { env } = getCloudflareContext()
    if ((env as unknown as Record<string, unknown>).NODE_ENV === "development") return "@alook/app"
  } catch {}
  return "@alook/cli"
}

export async function fetchLatestCliVersion(): Promise<string | null> {
  const pkg = getPackageName()
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}
