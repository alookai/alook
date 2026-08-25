"use client"

import { memo, useEffect, useRef, useState } from "react"
import { ExternalLink } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { tid } from "@/lib/community/testids"
import type { LinkPreview } from "@/lib/community/link-preview"
import { Card } from "@/components/ui/card"

type LinkPreviewResponse = {
  preview: LinkPreview | null
  staleTimeSeconds?: number
}

const POSITIVE_STALE_TIME_MS = 6 * 60 * 60 * 1_000
const NEGATIVE_STALE_TIME_MS = 5 * 60 * 1_000

export function linkPreviewStaleTime(data: LinkPreviewResponse | undefined): number {
  if (data?.staleTimeSeconds === 6 * 60 * 60) return POSITIVE_STALE_TIME_MS
  if (data?.staleTimeSeconds === 5 * 60) return NEGATIVE_STALE_TIME_MS
  return data?.preview ? POSITIVE_STALE_TIME_MS : NEGATIVE_STALE_TIME_MS
}

function LinkPreviewThumbnail({ src, onError }: { src: string; onError?: () => void }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    <img
      data-testid={tid.linkPreviewThumbnail}
      src={src}
      alt=""
      width={640}
      height={360}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="aspect-video w-full bg-muted object-cover"
      onError={() => {
        setFailed(true)
        onError?.()
      }}
    />
  )
}

export function LinkPreviewCardView({ preview }: { preview: LinkPreview }) {
  const [failed, setFailed] = useState(false)
  if (!preview.thumbnailUrl || failed) return null

  return (
    <div className="pb-2">
      <a
        data-testid={tid.linkPreviewCard}
        href={preview.url}
        target="_blank"
        rel="noopener noreferrer"
        className="group block w-full max-w-108 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Open link preview: ${preview.title}`}
      >
        <Card className="relative gap-0 py-0 transition-shadow group-hover:ring-foreground/20">
          <LinkPreviewThumbnail src={preview.thumbnailUrl} onError={() => setFailed(true)} />
          <span className="pointer-events-none absolute top-2 right-2 flex size-7 items-center justify-center rounded-full bg-background/80 text-foreground shadow-sm backdrop-blur-sm">
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </span>
        </Card>
      </a>
    </div>
  )
}

function LinkPreviewCardImpl({ url }: { url: string }) {
  const sentinelRef = useRef<HTMLSpanElement>(null)
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
    return (
      <span
        ref={sentinelRef}
        className="pointer-events-none absolute size-px overflow-hidden opacity-0"
        aria-hidden="true"
      />
    )
  }
  return <LinkPreviewCardView preview={preview} />
}

export const LinkPreviewCard = memo(LinkPreviewCardImpl)
