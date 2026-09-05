"use client"

import { Download } from "lucide-react"
import { useCallback } from "react"
import { cn } from "@/lib/utils"
import { useRemoteImageAttempt, useRemoteImageEligibility } from "./remote-image-attempt"

const EXTENSION_RE = /\.[^/.]+$/

function dimension(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

async function downloadRemoteImage(src: string, alt: string) {
  try {
    const blob = await fetch(src).then((response) => response.blob())
    const pathName = new URL(src, window.location.origin).pathname.split("/").pop() || ""
    const pathExtension = pathName.split(".").pop()
    const hasExtension = pathName.includes(".") && pathExtension && pathExtension.length <= 4
    let filename = pathName
    if (!hasExtension) {
      const extension = blob.type.includes("jpeg") || blob.type.includes("jpg")
        ? "jpg"
        : blob.type.includes("svg")
          ? "svg"
          : blob.type.includes("gif")
            ? "gif"
            : blob.type.includes("webp")
              ? "webp"
              : "png"
      filename = `${(alt || pathName || "image").replace(EXTENSION_RE, "")}.${extension}`
    }
    const objectUrl = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = objectUrl
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(objectUrl)
  } catch {
    window.open(src, "_blank")
  }
}

type MarkdownImageProps = Record<string, unknown> & {
  src?: string
  alt?: string
  className?: string
  width?: number | string
  height?: number | string
}

function MarkdownImageAttempt({
  src,
  alt = "",
  className,
  width,
  height,
  node,
  ...rest
}: MarkdownImageProps) {
  void node
  const [eligible, eligibilityRef] = useRemoteImageEligibility(true)
  const [status, attempt, , imageRef, onLoad, onError, retry] = useRemoteImageAttempt({
    eligible,
  })
  const imageWidth = dimension(width)
  const imageHeight = dimension(height)
  const aspectRatio = imageWidth && imageHeight ? `${imageWidth}/${imageHeight}` : "4/3"
  const frameWidth = imageWidth && imageHeight
    ? Math.min(imageWidth, 300 * imageWidth / imageHeight)
    : imageWidth ? Math.min(imageWidth, 300) : 300
  const download = useCallback(() => {
    if (src) void downloadRemoteImage(src, alt)
  }, [alt, src])

  if (!src) return null

  return (
    <div
      ref={eligibilityRef}
      data-streamdown="image-wrapper"
      data-remote-image-state={status}
      className="group relative my-4 inline-block max-w-full overflow-hidden rounded-lg bg-muted/30"
      style={{ width: `min(100%, ${frameWidth}px)`, aspectRatio }}
    >
      {status === "pending" && (
        <span
          aria-hidden
          data-remote-image-placeholder
          className="absolute inset-0 bg-muted/70 animate-pulse motion-reduce:animate-none"
        />
      )}
      <img
        {...rest}
        key={attempt}
        ref={imageRef}
        data-streamdown="image"
        data-remote-image-kind="content"
        data-remote-image-state={status}
        src={src}
        alt={alt}
        width={imageWidth}
        height={imageHeight}
        loading="lazy"
        className={cn(
          "absolute inset-0 size-full rounded-lg object-contain transition-opacity duration-150 ease-out motion-reduce:transition-none",
          status === "ready" ? "opacity-100" : "opacity-0",
          className,
        )}
        onLoad={onLoad}
        onError={onError}
      />
      {status === "error" && (
        <div
          role="status"
          data-streamdown="image-fallback"
          className="absolute inset-0 z-2 flex flex-col items-center justify-center gap-1 bg-muted px-2 text-center text-xs text-muted-foreground"
        >
          <span>Image not available</span>
          <button
            type="button"
            onClick={retry}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-3 font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Retry
          </button>
        </div>
      )}
      {status === "ready" && (
        <>
          <span className="pointer-events-none absolute inset-0 hidden rounded-lg bg-foreground/10 group-hover:block" />
          <button
            type="button"
            title="Download image"
            onClick={download}
            className="absolute right-2 bottom-2 flex size-8 cursor-pointer items-center justify-center rounded-md border border-border bg-background/90 opacity-0 shadow-sm backdrop-blur-sm transition-all duration-200 hover:bg-background group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Download className="size-3.5" />
          </button>
        </>
      )}
    </div>
  )
}

export function RemoteMarkdownImage(props: MarkdownImageProps) {
  return props.src ? <MarkdownImageAttempt key={props.src} {...props} /> : null
}
