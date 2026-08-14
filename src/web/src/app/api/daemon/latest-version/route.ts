import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { fetchLatestDaemonVersion } from "@/lib/npm"

export async function GET() {
  const result = await fetchLatestDaemonVersion()
  if (!result) {
    return writeError("failed to fetch latest daemon version from npm", 502)
  }
  return writeJSON(result)
}
