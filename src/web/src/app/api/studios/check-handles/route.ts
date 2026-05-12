import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, isValidHandle } from "@alook/shared";
import { nanoid } from "nanoid";
import { uniqueNamesGenerator, names } from "unique-names-generator";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError } from "@/lib/middleware/helpers";

export const POST = withAuth(async (req: NextRequest, _ctx) => {
  let body: { names: string[] };
  try {
    body = await req.json() as { names: string[] };
  } catch {
    return writeError("invalid request body", 400);
  }

  if (!Array.isArray(body.names) || body.names.length === 0 || body.names.length > 4) {
    return writeError("names must be an array of 1-4 strings", 400);
  }

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const results: { name: string; handle: string }[] = [];
  const usedHandles = new Set<string>();

  for (const name of body.names) {
    const base = name.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30);
    let handle = base;

    // Try base handle first
    if (isValidHandle(handle) && !usedHandles.has(handle)) {
      const existing = await queries.agent.getAgentByHandle(db, handle);
      if (!existing) {
        usedHandles.add(handle);
        results.push({ name, handle });
        continue;
      }
    }

    // Try with random name suffixes
    let found = false;
    for (let i = 0; i < 5; i++) {
      const suffix = uniqueNamesGenerator({ dictionaries: [names], length: 1, style: "lowerCase" });
      const candidate = `${base}-${suffix}`.slice(0, 30);
      if (!isValidHandle(candidate) || usedHandles.has(candidate)) continue;
      const existing = await queries.agent.getAgentByHandle(db, candidate);
      if (!existing) {
        handle = candidate;
        found = true;
        break;
      }
    }

    if (!found) {
      handle = `${base}-${nanoid(6)}`;
    }

    usedHandles.add(handle);
    results.push({ name, handle });
  }

  return writeJSON(results);
});
