import { getCloudflareContext } from "@opennextjs/cloudflare"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON } from "@/lib/middleware/helpers";

export const GET = withAuth(async () => {
  const { env } = getCloudflareContext()
  const raw = (env as Env).MIN_CLI_VERSION;
  return writeJSON({ min_cli_version: raw || null });
});
