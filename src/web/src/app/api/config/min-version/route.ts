import { getCloudflareContext } from "@opennextjs/cloudflare"
import { semverGte } from "@alook/shared";
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON } from "@/lib/middleware/helpers";
import { fetchLatestCliVersion } from "@/lib/npm";

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
