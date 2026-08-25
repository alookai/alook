"use client"

import { memo, useEffect, useRef, useState } from "react"
import { ExternalLink } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { tid } from "@/lib/community/testids"
import type { LinkPreview } from "@/lib/community/link-preview"

type LinkPreviewResponse = { preview: LinkPreview | null }

const POSITIVE_STALE_TIME_MS = 6 * 60 * 60 * 1_000
const NEGATIVE_STALE_TIME_MS = 5 * 60 * 1_000

export function linkPreviewStaleTime(data: LinkPreviewResponse | undefined): number {
  return data?.preview ? POSITIVE_STALE_TIME_MS : NEGATIVE_STALE_TIME_MS
}

export function LinkPreviewCardView({ preview }: { preview: LinkPreview }) {
  return (
    <a
      data-testid={tid.linkPreviewCard}
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group block max-w-108 rounded-lg border border-border bg-card px-3 py-2.5 text-foreground transition-colors hover:border-primary/35 hover:bg-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Open link preview: ${preview.title}`}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{preview.siteName ?? preview.hostname}</span>
        <ExternalLink aria-hidden="true" className="size-3 shrink-0 opacity-55 transition-opacity group-hover:opacity-90" />
      </div>
      <div className="mt-1 line-clamp-2 text-sm font-medium leading-snug">{preview.title}</div>
      {preview.description && (
        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {preview.description}
        </p>
      )}
    </a>
  )
}

function LinkPreviewCardImpl({ url }: { url: string }) {
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [nearViewport, setNearViewport] = useState(false)

  useEffect(() => {
    const node = sentinelRef.current
    if (!node || typeof IntersectionObserver === "undefined") {
      setNearViewport(true)
      return
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      setNearViewport(true)
      observer.disconnect()
    }, { rootMargin: "240px 0px" })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const query = useQuery({
    queryKey: communityKeys.linkPreview(url),
    queryFn: () => apiFetch<LinkPreviewResponse>("/api/community/link-preview", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
    enabled: nearViewport,
    staleTime: (query) => linkPreviewStaleTime(query.state.data),
    gcTime: 24 * 60 * 60 * 1_000,
    retry: false,
  })

  const preview = query.data?.preview
  if (!preview) {
    return <div ref={sentinelRef} className="h-px w-full" aria-hidden="true" />
  }
  return <LinkPreviewCardView preview={preview} />
}

export const LinkPreviewCard = memo(LinkPreviewCardImpl)
