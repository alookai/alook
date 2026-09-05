"use client"

import {
  Fragment,
  useEffect,
  useEffectEvent,
  type CSSProperties,
  type ImgHTMLAttributes,
  type MouseEvent,
} from "react"
import { cn } from "@/lib/utils"
import {
  REMOTE_IMAGE_TIMEOUT_MS,
  useRemoteImageAttempt,
  useRemoteImageEligibility,
  type RemoteImageStatus,
} from "./remote-image-attempt"

type IdentityImageProps = {
  src: string
  alt: string
  className?: string
  placeholderClassName?: string
  profilePhoto?: boolean
  timeoutMs?: number
  "data-testid"?: string
}

function IdentityImageAttempt({
  src,
  alt,
  className,
  placeholderClassName,
  profilePhoto = false,
  timeoutMs,
  "data-testid": testId,
}: IdentityImageProps) {
  const [status, attempt, , imageRef, onLoad, onError] = useRemoteImageAttempt({ timeoutMs })
  const legacyStatus = status === "error" ? "failed" : status

  return (
    <>
      <span
        data-slot={profilePhoto ? "avatar-photo-placeholder" : undefined}
        data-avatar-photo-placeholder={profilePhoto && status !== "ready" ? legacyStatus : undefined}
        data-remote-image-placeholder="identity"
        data-remote-image-state={status}
        aria-hidden
        className={cn(
          "absolute inset-0 bg-muted",
          status === "pending" && "animate-pulse motion-reduce:animate-none",
          placeholderClassName,
        )}
      />
      <img
        key={attempt}
        ref={imageRef}
        data-testid={testId}
        data-slot={profilePhoto ? "avatar-image" : undefined}
        data-avatar-photo-state={profilePhoto ? legacyStatus : undefined}
        data-remote-image-kind="identity"
        data-remote-image-state={status}
        src={src}
        alt={alt}
        className={cn(
          "absolute inset-0 size-full object-cover transition-opacity duration-150 ease-out motion-reduce:transition-none",
          status === "ready" ? "opacity-100" : "opacity-0",
          className,
        )}
        onLoad={onLoad}
        onError={onError}
      />
    </>
  )
}

export function RemoteIdentityImage(props: IdentityImageProps) {
  return <IdentityImageAttempt key={props.src} {...props} />
}

type ContentImageProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "children" | "onError" | "onLoad" | "ref" | "src" | "style"
> & {
  src: string
  alt: string
  frameClassName?: string
  frameStyle?: CSSProperties
  imageClassName?: string
  imageStyle?: CSSProperties
  loadingLabel?: string
  errorLabel?: string
  retryLabel?: string
  timeoutMs?: number
  onActivate?: (event: MouseEvent<HTMLButtonElement>) => void
  activateLabel?: string
  onReady?: (image: HTMLImageElement) => void
  onStateChange?: (status: RemoteImageStatus) => void
  "data-testid"?: string
}

function ContentImageAttempt({
  src,
  alt,
  frameClassName,
  frameStyle,
  imageClassName,
  imageStyle,
  loading = "lazy",
  loadingLabel,
  errorLabel = "Image failed to load",
  retryLabel = "Retry",
  timeoutMs = REMOTE_IMAGE_TIMEOUT_MS,
  onActivate,
  activateLabel,
  onReady,
  onStateChange,
  "data-testid": testId,
  ...imageProps
}: ContentImageProps) {
  const [eligible, eligibilityRef] = useRemoteImageEligibility(loading === "lazy")
  const [status, attempt, readyImage, imageRef, onLoad, onError, retry] = useRemoteImageAttempt({
    eligible,
    timeoutMs,
  })
  const notifyReady = useEffectEvent((image: HTMLImageElement) => onReady?.(image))

  useEffect(() => onStateChange?.(status), [onStateChange, status])
  useEffect(() => {
    if (status === "ready" && readyImage) notifyReady(readyImage)
  }, [readyImage, status])

  const media = (
    <Fragment>
      {status === "pending" && (
        <span
          data-remote-image-placeholder
          aria-hidden
          className="absolute inset-0 bg-muted/70 animate-pulse motion-reduce:animate-none"
        />
      )}
      {status === "pending" && loadingLabel && (
        <span className="absolute inset-0 flex items-center justify-center px-4 text-sm text-muted-foreground">
          {loadingLabel}
        </span>
      )}
      <img
        {...imageProps}
        key={attempt}
        ref={imageRef}
        data-testid={testId}
        data-remote-image-kind="content"
        data-remote-image-state={status}
        src={src}
        alt={alt}
        loading={loading}
        className={cn(
          "absolute inset-0 size-full transition-opacity duration-150 ease-out motion-reduce:transition-none",
          status === "ready" ? "opacity-100" : "opacity-0",
          imageClassName,
        )}
        style={imageStyle}
        onLoad={onLoad}
        onError={onError}
      />
    </Fragment>
  )

  return (
    <div
      ref={eligibilityRef}
      data-remote-image-frame
      data-remote-image-state={status}
      className={cn("relative overflow-hidden bg-muted/30", frameClassName)}
      style={frameStyle}
    >
      {onActivate && status !== "error" ? (
        <button
          type="button"
          aria-label={activateLabel ?? `Open ${alt}`}
          onClick={onActivate}
          className="absolute inset-0 z-1 block size-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {media}
        </button>
      ) : media}
      {status === "error" && (
        <div
          role="status"
          className="absolute inset-0 z-2 flex flex-col items-center justify-center gap-1 bg-muted px-2 text-center text-xs text-muted-foreground"
        >
          <span>{errorLabel}</span>
          <button
            type="button"
            onClick={retry}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-3 font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {retryLabel}
          </button>
        </div>
      )}
    </div>
  )
}

export function RemoteContentImage(props: ContentImageProps) {
  return <ContentImageAttempt key={props.src} {...props} />
}
