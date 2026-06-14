import { NextRequest } from "next/server";
import { queries, isValidHandle } from "@alook/shared";
import { nanoid } from "nanoid";
import { uniqueNamesGenerator, names } from "unique-names-generator";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError } from "@/lib/middleware/helpers";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  let body: { names: string[] };
  try {
    body = await req.json() as { names: string[] };
  } catch {
    return writeError("invalid request body", 400);
  }

  if (!Array.isArray(body.names) || body.names.length === 0 || body.names.length > 4) {
    return writeError("names must be an array of 1-4 strings", 400);
  }

  const db = getDb(ctx.env.DB);

  // Generate all candidate handles upfront
  const candidatesPerName: { name: string; candidates: string[] }[] = [];
  for (const name of body.names) {
    const base = name.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30);
    const candidates: string[] = [];
    if (isValidHandle(base)) candidates.push(base);
    for (let i = 0; i < 5; i++) {
      const suffix = uniqueNamesGenerator({ dictionaries: [names], length: 1, style: "lowerCase" });
      const candidate = `${base}-${suffix}`.slice(0, 30);
      if (isValidHandle(candidate)) candidates.push(candidate);
    }
    candidatesPerName.push({ name, candidates });
  }

  // Batch-fetch existence of all candidates in a single query
  const allCandidates = candidatesPerName.flatMap((c) => c.candidates);
  const existingHandles = new Set(
    await queries.agent.getExistingHandles(db, allCandidates)
  );

  // Assign handles using in-memory Set lookups
  const usedHandles = new Set<string>();
  const results: { name: string; handle: string }[] = [];

  for (const { name, candidates } of candidatesPerName) {
    let handle: string | undefined;
    for (const candidate of candidates) {
      if (!existingHandles.has(candidate) && !usedHandles.has(candidate)) {
        handle = candidate;
        break;
      }
    }
    if (!handle) {
      const base = name.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30);
      handle = `${base}-${nanoid(6)}`;
    }
    usedHandles.add(handle);
    results.push({ name, handle });
  }

  return writeJSON(results);
});
