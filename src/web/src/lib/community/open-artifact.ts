import { z } from "zod"
import { apiFetch } from "@/lib/api/client"
import { ApiError, CommunityResourceError } from "@/lib/errors"
import type { OpenArtifactSavedState } from "./open-artifact-policy"

const ALOOK_PAGE_EMBED_KIND = "alook_page" as const

const AlookPageEmbedSchema = z.object({
  kind: z.literal(ALOOK_PAGE_EMBED_KIND),
  id: z.string().trim().min(1),
  type: z.string().trim().min(1),
  title: z.string().trim().min(1),
})

export type AlookPageEmbed = z.infer<typeof AlookPageEmbedSchema>

export type AlookPageOpenTarget = AlookPageEmbed & {
  sourceMessageId?: string
}

const PageViewerTokenResponseSchema = z.object({
  embedUrl: z.string().trim().min(1),
  allowedOrigins: z.array(z.string()),
  expiresAt: z.string().trim().min(1),
})

type PageViewerTokenResponse = z.infer<typeof PageViewerTokenResponseSchema>

const PageCommentResponseSchema = z.looseObject({
  id: z.string().trim().min(1).optional(),
  messageId: z.string().trim().min(1).optional(),
  channelId: z.string().trim().min(1).optional(),
  seq: z.number().int().positive().optional(),
})

type PageCommentResponse = z.infer<typeof PageCommentResponseSchema>

export function extractAlookPagesFromEmbeds(
  embeds: readonly unknown[] | undefined,
): { pages: AlookPageEmbed[]; otherEmbeds: unknown[] } {
  if (!embeds || embeds.length === 0) return { pages: [], otherEmbeds: [] }
  const pages: AlookPageEmbed[] = []
  const otherEmbeds: unknown[] = []
  const seenIds = new Set<string>()
  for (const entry of embeds) {
    if (
      typeof entry === "object"
      && entry !== null
      && (entry as { kind?: unknown }).kind === ALOOK_PAGE_EMBED_KIND
    ) {
      const parsed = AlookPageEmbedSchema.safeParse(entry)
      if (parsed.success && !seenIds.has(parsed.data.id)) {
        seenIds.add(parsed.data.id)
        pages.push(parsed.data)
      }
      continue
    }
    otherEmbeds.push(entry)
  }
  return { pages, otherEmbeds }
}

export async function fetchPageViewerToken(
  pageId: string,
  options?: { signal?: AbortSignal; sourceMessageId?: string },
): Promise<PageViewerTokenResponse> {
  const sourceMessageId = options?.sourceMessageId?.trim()
  const data = await apiFetch<unknown>(
    `/api/community/pages/${encodeURIComponent(pageId)}/viewer-token`,
    {
      method: "POST",
      ...(sourceMessageId ? { body: JSON.stringify({ sourceMessageId }) } : {}),
      signal: options?.signal,
    },
  )
  return PageViewerTokenResponseSchema.parse(data)
}

export async function submitPageComment(
  pageId: string,
  input: { text: string; location?: string; sourceMessageId?: string },
  options?: { signal?: AbortSignal },
): Promise<PageCommentResponse> {
  const text = input.text.trim()
  if (!text) throw new Error("Comment text is required")
  const payload: { text: string; location?: string; sourceMessageId?: string } = { text }
  const location = input.location?.trim()
  if (location) payload.location = location
  const sourceMessageId = input.sourceMessageId?.trim()
  if (sourceMessageId) payload.sourceMessageId = sourceMessageId
  const data = await apiFetch<unknown>(
    `/api/community/pages/${encodeURIComponent(pageId)}/comments`,
    {
      method: "POST",
      body: JSON.stringify(payload),
      signal: options?.signal,
    },
  )
  return PageCommentResponseSchema.parse(data ?? {})
}

export type PageViewerErrorKind = "unauthenticated" | "revoked" | "unavailable" | "error"

export function classifyPageViewerError(error: unknown): {
  kind: PageViewerErrorKind
  title: string
  description: string
  retryable: boolean
} {
  const status = error instanceof ApiError || error instanceof CommunityResourceError
    ? error.status
    : undefined
  if (status === 401) {
    return {
      kind: "unauthenticated",
      title: "Sign in required",
      description: "Sign in to your Alook account to open this page.",
      retryable: false,
    }
  }
  if (status === 403 || status === 404 || status === 410) {
    return {
      kind: "revoked",
      title: "Access unavailable",
      description: "This page was deleted or you no longer have access to its conversation.",
      retryable: false,
    }
  }
  if (status === 503) {
    return {
      kind: "unavailable",
      title: "Page host unavailable",
      description: "The page host is temporarily unavailable. Try again shortly.",
      retryable: true,
    }
  }
  return {
    kind: "error",
    title: "Could not open page",
    description: error instanceof Error && error.message ? error.message : "Something went wrong while opening this page.",
    retryable: true,
  }
}

export function describePageType(type: string): {
  kind: "doc" | "slides" | "other"
  label: string
} {
  const normalized = type.trim().toLowerCase()
  if (normalized === "doc" || normalized === "docs" || normalized === "document") {
    return { kind: "doc", label: "Document" }
  }
  if (normalized === "slides" || normalized === "slide" || normalized === "deck" || normalized === "presentation") {
    return { kind: "slides", label: "Slides" }
  }
  const clean = normalized.replace(/[_-]+/g, " ").trim()
  if (!clean) return { kind: "other", label: "Page" }
  return {
    kind: "other",
    label: clean.charAt(0).toUpperCase() + clean.slice(1),
  }
}

export function describePageSaveState(state: OpenArtifactSavedState | null): string | null {
  switch (state) {
    case "saved":
      return "Saved"
    case "saving":
      return "Saving…"
    case "unsaved":
      return "Unsaved changes"
    case "reconnecting":
      return "Reconnecting…"
    case "readonly":
      return "View only"
    default:
      return null
  }
}
