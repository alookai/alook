import { z } from "zod";

const pageId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const ALOOK_PAGE_EMBED_KIND = "alook_page" as const;

export const AlookPageEmbedSchema = z.strictObject({
  kind: z.literal(ALOOK_PAGE_EMBED_KIND),
  id: pageId,
  type: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().trim().min(1).max(256),
});

export type AlookPageEmbed = z.infer<typeof AlookPageEmbedSchema>;

export function getAlookPageEmbeds(embeds: readonly unknown[] | undefined): AlookPageEmbed[] {
  const pages = new Map<string, AlookPageEmbed>();
  for (const value of embeds ?? []) {
    const result = AlookPageEmbedSchema.safeParse(value);
    if (result.success) pages.set(result.data.id, result.data);
  }
  return [...pages.values()];
}

export const AlookPageSourceSchema = z.strictObject({ sourceMessageId: z.string().min(1).max(128).optional() });

export const AlookPageCommentSchema = AlookPageSourceSchema.extend({
  text: z.string().trim().min(1).max(8000),
  location: z.string().trim().min(1).max(1024).optional(),
});

export const AlookPageViewerSchema = z.strictObject({
  embedUrl: z.url(),
  allowedOrigins: z.array(z.url()).min(1).max(2),
  expiresAt: z.iso.datetime(),
});

export type AlookPageViewer = z.infer<typeof AlookPageViewerSchema>;

const artifactPath = z.string().min(1).max(512).refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((part) => part === ".." || part === "." || part === ""), "A relative artifact path is required");
export const AlookPageOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("actions") }),
  z.strictObject({ kind: z.literal("manifest") }),
  z.strictObject({ kind: z.literal("read"), path: artifactPath }),
  z.strictObject({ kind: z.literal("write"), writes: z.array(z.strictObject({ path: artifactPath, content: z.string().max(1_398_104).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).refine((value) => value.length * 3 / 4 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0) <= 1024 * 1024).nullable(), if_match: z.string().max(256).nullable() })).min(1).max(16) }),
  z.strictObject({ kind: z.literal("action"), name: z.string().min(1).max(128), args: z.record(z.string(), z.unknown()) }),
]);
export type AlookPageOperation = z.infer<typeof AlookPageOperationSchema>;
