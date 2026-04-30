import { getCloudflareContext } from "@opennextjs/cloudflare"
import { semverGte } from "@alook/shared";
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON } from "@/lib/middleware/helpers";

async function fetchLatestCliVersion(): Promise<string | null> {
  try {
    const res = await fetch("https://registry.npmjs.org/@alook/cli/latest");
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

export const GET = withAuth(async () => {
  const { env } = getCloudflareContext()
  const raw = (env as Env).MIN_CLI_VERSION;
  if (!raw) return writeJSON({ min_cli_version: null });

  const latest = await fetchLatestCliVersion();
  if (latest && !semverGte(latest, raw)) {
    // MIN_CLI_VERSION is higher than what's published — ignore it
    return writeJSON({ min_cli_version: null });
  }

  return writeJSON({ min_cli_version: raw });
});
