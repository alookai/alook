import { withAuth } from "@/lib/middleware/auth";
import { writeJSON } from "@/lib/middleware/helpers";

export const GET = withAuth(async (_req, ctx) => {
  const raw = ctx.env.RUNTIME_MODEL_OPTIONS;
  if (!raw) return writeJSON({});

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return writeJSON({});
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return writeJSON({});
  }

  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      result[key] = value as string[];
    }
  }

  return writeJSON(result);
});
