import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { fetchLatestCliVersion } from "@/lib/npm";

export async function GET() {
  const version = await fetchLatestCliVersion();
  if (!version) {
    return writeError("failed to fetch latest version from npm", 502);
  }
  return writeJSON({ version });
}
