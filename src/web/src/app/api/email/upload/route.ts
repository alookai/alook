import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { nanoid } from "nanoid";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const bucket = (env as Env).EMAIL_BUCKET;

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return writeError("invalid form data", 400);
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return writeError("file is required", 400);
  }

  if (file.size > MAX_FILE_SIZE) {
    return writeError("file exceeds 10 MB limit", 413);
  }

  const draftId = nanoid();
  const key = `emails/drafts/${draftId}/${file.name}`;

  await bucket.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });

  return writeJSON({
    key,
    filename: file.name,
    size: file.size,
    contentType: file.type || "application/octet-stream",
  });
});
