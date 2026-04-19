import { writeJSON, writeError } from "@/lib/middleware/helpers";

export async function GET() {
  try {
    const res = await fetch("https://registry.npmjs.org/@alook/cli/latest");
    if (!res.ok) {
      return writeError("npm registry returned " + res.status, 502);
    }
    const data = (await res.json()) as { version?: string };
    if (!data.version) {
      return writeError("npm registry response missing version", 502);
    }
    return writeJSON({ version: data.version });
  } catch {
    return writeError("failed to reach npm registry", 502);
  }
}
