import { createHash } from "node:crypto";
import { alookSubject } from "./plugin.mjs";

export async function deliverPageRequest(env, artifactId, body = {}) {
  const items = [...(body.requests ?? []).map((item) => ({ kind: "request", item })), ...(body.threads ?? []).map((item) => ({ kind: "thread", item }))];
  if (items.length === 0 || items.length > 8) throw new Error("Invalid Page feedback");
  for (const { kind, item } of items) {
    const subject = alookSubject({ kind: "user", id: item.from?.userId });
    const text = kind === "thread" ? item.messages?.at(-1)?.text : item.text;
    if (!subject || typeof text !== "string" || !text.trim() || text.length > 8000) throw new Error("Page feedback requires its authenticated author");
    const location = [item.file, item.where, item.anchor, kind === "thread" ? `Comment ${item.id}` : item.label, item.selection].filter((value) => typeof value === "string" && value).join(" · ").slice(0, 1024);
    const nonce = `page:${createHash("sha256").update(JSON.stringify([artifactId, subject, kind, item.id, kind === "thread" ? item.messages?.at(-1)?.at : item.sentAt, text])).digest("hex")}`;
    const request = new Request(new URL("/api/community/pages/artifact-comment", env.ALOOK_WEB_ORIGIN), {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.ALOOK_PAGE_SERVICE_KEY}` },
      body: JSON.stringify({ subject, artifactId, text, ...(location ? { location } : {}), nonce }), signal: AbortSignal.timeout(10_000),
    });
    const response = await env.ALOOK_WEB.fetch(request);
    await response.body?.cancel();
    if (!response.ok) throw new Error("Page feedback could not be sent. Retry from the Page.");
  }
  return { status: "delivered", via: "live" };
}
