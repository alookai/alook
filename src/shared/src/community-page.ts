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

export const AlookPageCommentSchema = z.strictObject({
  text: z.string().trim().min(1).max(8000),
  location: z.string().trim().min(1).max(1024).optional(),
});

export const AlookPageViewerSchema = z.strictObject({
  embedUrl: z.url(),
  allowedOrigins: z.array(z.url()).min(1).max(2),
  expiresAt: z.iso.datetime(),
});

export type AlookPageViewer = z.infer<typeof AlookPageViewerSchema>;
