"use client"

import { useState } from "react"
import { ArrowUpRight, File, FileText, Presentation } from "@/components/icons/lucide"
import {
  buildPageCoverUrl,
  describePageType,
  type AlookPageEmbed,
  type AlookPageOpenTarget,
} from "@/lib/community/open-artifact"
import { tid } from "@/lib/community/testids"
import { useUiHandlers } from "@/stores/community"
import styles from "./open-artifact-card.module.css"

type FallbackKind =
  | "docs"
  | "slides"
  | "sheets"
  | "whiteboard"
  | "design"
  | "data"
  | "motion"
  | "design-system"
  | "page"

function resolveFallbackKind(type: string): FallbackKind {
  const normalized = type.trim().toLowerCase().replace(/[_ ]+/g, "-")
  if (normalized === "doc" || normalized === "docs" || normalized === "document") return "docs"
  if (normalized === "slides" || normalized === "slide" || normalized === "deck" || normalized === "presentation") return "slides"
  if (normalized === "sheets" || normalized === "sheet" || normalized === "spreadsheet") return "sheets"
  if (normalized === "whiteboard" || normalized === "board") return "whiteboard"
  if (normalized === "design") return "design"
  if (normalized === "data" || normalized === "dashboard" || normalized === "analytics") return "data"
  if (normalized === "motion" || normalized === "animation" || normalized === "video") return "motion"
  if (normalized === "design-system" || normalized === "designsystem") return "design-system"
  return "page"
}

function PageKindIcon({ kind }: { kind: "doc" | "slides" | "other" }) {
  if (kind === "doc") return <FileText className="size-3.5 shrink-0" aria-hidden="true" />
  if (kind === "slides") return <Presentation className="size-3.5 shrink-0" aria-hidden="true" />
  return <File className="size-3.5 shrink-0" aria-hidden="true" />
}

function PageFallbackSvg({ kind }: { kind: FallbackKind }) {
  return (
    <svg
      viewBox="0 0 320 200"
      fill="none"
      aria-hidden="true"
      data-fallback-kind={kind}
      className={styles.fallbackSvg}
    >
      {kind === "docs" && (
        <>
          <rect x="0" y="0" width="74" height="200" fill="var(--oa-svg-surface)" />
          <line x1="74" y1="0" x2="74" y2="200" stroke="var(--oa-svg-line)" />
          <rect x="14" y="24" width="38" height="6" rx="3" fill="var(--oa-svg-ink)" />
          <rect x="14" y="40" width="46" height="4.5" rx="2.25" fill="var(--oa-blue)" />
          <rect x="20" y="54" width="36" height="4" rx="2" fill="var(--oa-svg-muted)" />
          <rect x="20" y="66" width="30" height="4" rx="2" fill="var(--oa-svg-muted)" />
          <rect x="96" y="26" width="128" height="10" rx="5" fill="var(--oa-svg-ink)" />
          <rect x="260" y="26" width="36" height="10" rx="5" fill="var(--oa-sage)" fillOpacity="0.28" />
          <rect x="96" y="48" width="194" height="5" rx="2.5" fill="var(--oa-svg-muted)" />
          <rect x="96" y="60" width="166" height="5" rx="2.5" fill="var(--oa-svg-muted)" />
          <rect x="96" y="80" width="198" height="44" rx="8" fill="var(--oa-blue)" fillOpacity="0.14" stroke="var(--oa-blue)" strokeOpacity="0.34" />
          <circle cx="112" cy="96" r="4" fill="var(--oa-blue)" />
          <rect x="124" y="93" width="122" height="5" rx="2.5" fill="var(--oa-svg-ink)" />
          <rect x="124" y="106" width="92" height="4.5" rx="2.25" fill="var(--oa-svg-muted)" />
          <rect x="96" y="140" width="184" height="5" rx="2.5" fill="var(--oa-svg-muted)" />
          <rect x="96" y="153" width="142" height="5" rx="2.5" fill="var(--oa-svg-muted)" />
        </>
      )}

      {kind === "slides" && (
        <>
          <rect x="0" y="0" width="76" height="200" fill="var(--oa-svg-surface)" />
          <line x1="76" y1="0" x2="76" y2="200" stroke="var(--oa-svg-line)" />
          <rect x="12" y="18" width="52" height="36" rx="5" fill="var(--oa-viewport-bg)" stroke="var(--oa-svg-line)" />
          <rect x="12" y="64" width="52" height="36" rx="5" fill="var(--oa-viewport-bg)" stroke="var(--oa-blue)" strokeWidth="1.5" />
          <rect x="12" y="110" width="52" height="36" rx="5" fill="var(--oa-viewport-bg)" stroke="var(--oa-svg-line)" />
          <rect x="94" y="20" width="208" height="160" rx="10" fill="var(--oa-svg-surface)" stroke="var(--oa-svg-line)" />
          <rect x="112" y="38" width="46" height="7" rx="3.5" fill="var(--oa-blue)" />
          <rect x="112" y="54" width="144" height="10" rx="5" fill="var(--oa-svg-ink)" />
          <rect x="112" y="84" width="88" height="74" rx="8" fill="var(--oa-blue)" fillOpacity="0.14" />
          <rect x="124" y="128" width="16" height="22" rx="3" fill="var(--oa-blue)" fillOpacity="0.55" />
          <rect x="148" y="112" width="16" height="38" rx="3" fill="var(--oa-blue)" fillOpacity="0.78" />
          <rect x="172" y="98" width="16" height="52" rx="3" fill="var(--oa-blue)" />
          <rect x="214" y="96" width="70" height="6" rx="3" fill="var(--oa-svg-ink)" />
          <rect x="214" y="112" width="60" height="5" rx="2.5" fill="var(--oa-svg-muted)" />
          <rect x="214" y="126" width="50" height="5" rx="2.5" fill="var(--oa-svg-muted)" />
        </>
      )}

      {kind === "sheets" && (
        <>
          <rect x="0" y="0" width="320" height="34" fill="var(--oa-svg-surface)" />
          <line x1="0" y1="34" x2="320" y2="34" stroke="var(--oa-svg-line)" />
          <rect x="18" y="13" width="14" height="8" rx="3" fill="var(--oa-blue)" />
          <rect x="44" y="14" width="120" height="6" rx="3" fill="var(--oa-svg-muted)" />
          <line x1="0" y1="68" x2="320" y2="68" stroke="var(--oa-svg-line)" />
          <line x1="0" y1="102" x2="320" y2="102" stroke="var(--oa-svg-line)" />
          <line x1="0" y1="136" x2="320" y2="136" stroke="var(--oa-svg-line)" />
          <line x1="0" y1="170" x2="320" y2="170" stroke="var(--oa-svg-line)" />
          <line x1="92" y1="34" x2="92" y2="200" stroke="var(--oa-svg-line)" />
          <line x1="172" y1="34" x2="172" y2="200" stroke="var(--oa-svg-line)" />
          <line x1="246" y1="34" x2="246" y2="200" stroke="var(--oa-svg-line)" />
          <rect x="92" y="68" width="80" height="34" fill="var(--oa-blue)" fillOpacity="0.16" stroke="var(--oa-blue)" strokeWidth="1.5" />
          <rect x="18" y="48" width="52" height="5" rx="2.5" fill="var(--oa-svg-ink)" />
          <rect x="106" y="82" width="44" height="5" rx="2.5" fill="var(--oa-blue)" />
          <rect x="0" y="170" width="320" height="30" fill="var(--oa-sage)" fillOpacity="0.14" />
          <rect x="260" y="182" width="42" height="5" rx="2.5" fill="var(--oa-sage)" />
        </>
      )}

      {kind === "whiteboard" && (
        <>
          <path d="M108 72 C148 72 152 54 192 54" stroke="var(--oa-blue)" strokeWidth="2" strokeLinecap="round" />
          <path d="M108 94 C150 94 152 132 196 132" stroke="var(--oa-svg-muted)" strokeWidth="1.6" strokeDasharray="4 4" strokeLinecap="round" />
          <rect x="24" y="42" width="84" height="72" rx="10" fill="var(--oa-orange)" fillOpacity="0.18" stroke="var(--oa-orange)" strokeOpacity="0.48" />
          <rect x="38" y="60" width="48" height="6" rx="3" fill="var(--oa-svg-ink)" />
          <rect x="38" y="74" width="56" height="4.5" rx="2.25" fill="var(--oa-svg-muted)" />
          <rect x="192" y="34" width="102" height="42" rx="10" fill="var(--oa-svg-surface)" stroke="var(--oa-blue)" strokeWidth="1.5" />
          <rect x="208" y="51" width="64" height="6" rx="3" fill="var(--oa-svg-ink)" />
          <rect x="196" y="112" width="96" height="38" rx="19" fill="var(--oa-sage)" fillOpacity="0.18" stroke="var(--oa-sage)" strokeOpacity="0.52" />
          <circle cx="216" cy="131" r="4.5" fill="var(--oa-sage)" />
          <rect x="228" y="128" width="48" height="5.5" rx="2.75" fill="var(--oa-svg-ink)" />
        </>
      )}

      {kind === "design" && (
        <>
          <rect x="0" y="0" width="62" height="200" fill="var(--oa-svg-surface)" />
          <rect x="258" y="0" width="62" height="200" fill="var(--oa-svg-surface)" />
          <line x1="62" y1="0" x2="62" y2="200" stroke="var(--oa-svg-line)" />
          <line x1="258" y1="0" x2="258" y2="200" stroke="var(--oa-svg-line)" />
          <rect x="12" y="28" width="38" height="5" rx="2.5" fill="var(--oa-blue)" />
          <rect x="16" y="42" width="30" height="4.5" rx="2.25" fill="var(--oa-svg-muted)" />
          <rect x="92" y="32" width="136" height="136" rx="12" fill="var(--oa-svg-surface)" stroke="var(--oa-svg-line)" />
          <circle cx="136" cy="84" r="22" fill="var(--oa-orange)" fillOpacity="0.24" stroke="var(--oa-orange)" strokeOpacity="0.55" />
          <rect x="128" y="76" width="76" height="56" rx="6" fill="var(--oa-blue)" fillOpacity="0.18" stroke="var(--oa-blue)" strokeWidth="1.5" />
          <rect x="272" y="28" width="12" height="12" rx="3" fill="var(--oa-blue)" />
          <rect x="290" y="28" width="12" height="12" rx="3" fill="var(--oa-orange)" />
          <rect x="272" y="48" width="12" height="12" rx="3" fill="var(--oa-sage)" />
        </>
      )}

      {kind === "data" && (
        <>
          <rect x="18" y="18" width="88" height="44" rx="8" fill="var(--oa-svg-surface)" stroke="var(--oa-svg-line)" />
          <rect x="116" y="18" width="88" height="44" rx="8" fill="var(--oa-svg-surface)" stroke="var(--oa-svg-line)" />
          <rect x="214" y="18" width="88" height="44" rx="8" fill="var(--oa-svg-surface)" stroke="var(--oa-svg-line)" />
          <rect x="30" y="38" width="42" height="8" rx="4" fill="var(--oa-svg-ink)" />
          <rect x="128" y="38" width="38" height="8" rx="4" fill="var(--oa-svg-ink)" />
          <rect x="226" y="38" width="46" height="8" rx="4" fill="var(--oa-svg-ink)" />
          <rect x="18" y="74" width="186" height="108" rx="8" fill="var(--oa-svg-surface)" stroke="var(--oa-svg-line)" />
          <rect x="34" y="132" width="18" height="36" rx="4" fill="var(--oa-blue)" fillOpacity="0.28" />
          <rect x="62" y="116" width="18" height="52" rx="4" fill="var(--oa-blue)" fillOpacity="0.38" />
          <rect x="90" y="124" width="18" height="44" rx="4" fill="var(--oa-blue)" fillOpacity="0.32" />
          <rect x="118" y="102" width="18" height="66" rx="4" fill="var(--oa-blue)" fillOpacity="0.52" />
          <rect x="146" y="88" width="18" height="80" rx="4" fill="var(--oa-blue)" />
          <rect x="174" y="108" width="18" height="60" rx="4" fill="var(--oa-blue)" fillOpacity="0.4" />
          <rect x="214" y="74" width="88" height="108" rx="8" fill="var(--oa-svg-surface)" stroke="var(--oa-svg-line)" />
          <circle cx="258" cy="128" r="24" stroke="var(--oa-svg-line)" strokeWidth="7" />
          <circle cx="258" cy="128" r="24" stroke="var(--oa-sage)" strokeWidth="7" strokeDasharray="96 60" strokeLinecap="round" transform="rotate(-90 258 128)" />
        </>
      )}

      {kind === "motion" && (
        <>
          <path d="M52 94 Q158 18 248 64" stroke="var(--oa-blue)" strokeWidth="2" strokeDasharray="5 5" strokeLinecap="round" />
          <circle cx="78" cy="76" r="12" fill="var(--oa-blue)" fillOpacity="0.18" stroke="var(--oa-blue)" strokeOpacity="0.5" />
          <circle cx="156" cy="48" r="16" fill="var(--oa-blue)" fillOpacity="0.24" stroke="var(--oa-blue)" strokeOpacity="0.7" />
          <rect x="220" y="40" width="54" height="40" rx="10" fill="var(--oa-blue)" />
          <polygon points="242,52 242,68 256,60" fill="var(--oa-viewport-bg)" />
          <rect x="0" y="126" width="320" height="74" fill="var(--oa-svg-surface)" />
          <line x1="0" y1="126" x2="320" y2="126" stroke="var(--oa-svg-line)" />
          <rect x="34" y="144" width="176" height="8" rx="4" fill="var(--oa-blue)" fillOpacity="0.28" />
          <rect x="78" y="162" width="154" height="8" rx="4" fill="var(--oa-sage)" fillOpacity="0.32" />
          <rect x="52" y="180" width="128" height="8" rx="4" fill="var(--oa-orange)" fillOpacity="0.32" />
          <line x1="186" y1="126" x2="186" y2="200" stroke="var(--oa-orange)" strokeWidth="2" />
          <circle cx="186" cy="130" r="4" fill="var(--oa-orange)" />
        </>
      )}

      {kind === "design-system" && (
        <>
          <rect x="18" y="20" width="134" height="160" rx="10" fill="var(--oa-svg-surface)" stroke="var(--oa-svg-line)" />
          <rect x="34" y="42" width="36" height="30" rx="6" fill="var(--oa-svg-ink)" />
          <rect x="80" y="48" width="54" height="7" rx="3.5" fill="var(--oa-svg-ink)" />
          <rect x="80" y="61" width="40" height="5" rx="2.5" fill="var(--oa-svg-muted)" />
          <rect x="34" y="132" width="22" height="28" rx="5" fill="var(--oa-blue)" />
          <rect x="62" y="132" width="22" height="28" rx="5" fill="var(--oa-sage)" />
          <rect x="90" y="132" width="22" height="28" rx="5" fill="var(--oa-orange)" />
          <rect x="118" y="132" width="22" height="28" rx="5" fill="var(--oa-svg-ink)" />
          <rect x="164" y="20" width="138" height="160" rx="10" fill="var(--oa-svg-surface)" stroke="var(--oa-svg-line)" />
          <rect x="180" y="40" width="54" height="26" rx="7" fill="var(--oa-blue)" />
          <rect x="242" y="40" width="44" height="26" rx="7" fill="var(--oa-viewport-bg)" stroke="var(--oa-svg-line)" />
          <rect x="180" y="84" width="42" height="22" rx="11" fill="var(--oa-sage)" />
          <circle cx="211" cy="95" r="7.5" fill="#ffffff" />
          <rect x="180" y="126" width="106" height="32" rx="7" fill="var(--oa-viewport-bg)" stroke="var(--oa-svg-line)" />
        </>
      )}

      {kind === "page" && (
        <>
          <rect x="18" y="18" width="284" height="46" rx="10" fill="var(--oa-svg-surface)" stroke="var(--oa-svg-line)" />
          <rect x="32" y="30" width="22" height="22" rx="6" fill="var(--oa-blue)" fillOpacity="0.22" stroke="var(--oa-blue)" strokeOpacity="0.4" />
          <rect x="66" y="34" width="112" height="7" rx="3.5" fill="var(--oa-svg-ink)" />
          <rect x="66" y="46" width="76" height="4.5" rx="2.25" fill="var(--oa-svg-muted)" />
          <rect x="246" y="33" width="42" height="16" rx="8" fill="var(--oa-blue)" />
          <rect x="18" y="76" width="146" height="106" rx="10" fill="var(--oa-svg-surface)" stroke="var(--oa-svg-line)" />
          <rect x="30" y="88" width="122" height="48" rx="6" fill="var(--oa-blue)" fillOpacity="0.16" />
          <rect x="30" y="148" width="96" height="5.5" rx="2.75" fill="var(--oa-svg-ink)" />
          <rect x="30" y="160" width="72" height="4.5" rx="2.25" fill="var(--oa-svg-muted)" />
          <rect x="176" y="76" width="126" height="48" rx="10" fill="var(--oa-svg-surface)" stroke="var(--oa-svg-line)" />
          <rect x="190" y="92" width="76" height="5.5" rx="2.75" fill="var(--oa-svg-ink)" />
          <rect x="190" y="104" width="54" height="4.5" rx="2.25" fill="var(--oa-svg-muted)" />
          <rect x="176" y="134" width="126" height="48" rx="10" fill="var(--oa-svg-surface)" stroke="var(--oa-svg-line)" />
          <rect x="190" y="150" width="66" height="5.5" rx="2.75" fill="var(--oa-sage)" />
          <rect x="190" y="162" width="88" height="4.5" rx="2.25" fill="var(--oa-svg-muted)" />
        </>
      )}
    </svg>
  )
}

export function OpenArtifactCard({
  page,
  sourceMessageId,
  onOpen,
  disabled = false,
}: {
  page: AlookPageEmbed
  sourceMessageId?: string
  onOpen?: (page: AlookPageOpenTarget) => void
  disabled?: boolean
}) {
  const typeInfo = describePageType(page.type)
  const fallbackKind = resolveFallbackKind(page.type)
  const coverUrl = buildPageCoverUrl(page.id, sourceMessageId)
  const [coverStatus, setCoverStatus] = useState<{ url: string; state: "loaded" | "error" } | null>(null)
  const isLoaded = coverStatus?.url === coverUrl && coverStatus.state === "loaded"
  const isError = coverStatus?.url === coverUrl && coverStatus.state === "error"

  return (
    <button
      type="button"
      disabled={disabled}
      data-testid={tid.openArtifactCard(page.id)}
      data-page-type={page.type}
      data-has-cover={isError ? "false" : "true"}
      onClick={() => onOpen?.(sourceMessageId ? { ...page, sourceMessageId } : page)}
      aria-label={`Open ${typeInfo.label}: ${page.title}`}
      className={`${styles.card} focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none`}
    >
      <span className={styles.viewportWrap} aria-hidden="true">
        <span className={styles.viewport}>
          <PageFallbackSvg kind={fallbackKind} />
          {!isError && (
            <img
              src={coverUrl}
              alt=""
              loading="lazy"
              decoding="async"
              onLoad={() => setCoverStatus({ url: coverUrl, state: "loaded" })}
              onError={() => setCoverStatus({ url: coverUrl, state: "error" })}
              className={`${styles.coverImage} ${isLoaded ? styles.coverImageLoaded : ""}`}
            />
          )}
        </span>
      </span>

      <span className={styles.footer}>
        <span className={styles.meta}>
          <span className={styles.icon} aria-hidden="true">
            <PageKindIcon kind={typeInfo.kind} />
          </span>
          <span className={styles.textGroup}>
            <span className={styles.title}>{page.title}</span>
            <span className={styles.subtitle}>{typeInfo.label}</span>
          </span>
        </span>
        <span className={styles.openCue}>
          <span>Open</span>
          <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
        </span>
      </span>
    </button>
  )
}

function RuntimeOpenArtifactCard({
  page,
  sourceMessageId,
  disabled = false,
}: {
  page: AlookPageEmbed
  sourceMessageId?: string
  disabled?: boolean
}) {
  const uiHandlers = useUiHandlers()
  return (
    <OpenArtifactCard
      page={page}
      sourceMessageId={sourceMessageId}
      disabled={disabled}
      onOpen={(target) => uiHandlers.openPage?.(target)}
    />
  )
}

export function MessageOpenArtifactCard({
  page,
  sourceMessageId,
  onOpenPage,
  disabled = false,
}: {
  page: AlookPageEmbed
  sourceMessageId?: string
  onOpenPage?: (page: AlookPageOpenTarget) => void
  disabled?: boolean
}) {
  if (onOpenPage) {
    return (
      <OpenArtifactCard
        page={page}
        sourceMessageId={sourceMessageId}
        onOpen={onOpenPage}
        disabled={disabled}
      />
    )
  }
  return <RuntimeOpenArtifactCard page={page} sourceMessageId={sourceMessageId} disabled={disabled} />
}
