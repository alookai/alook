"use client"

import { ArrowUpRight, File, FileText, Presentation } from "@/components/icons/lucide"
import { describePageType, type AlookPageEmbed } from "@/lib/community/open-artifact"
import { tid } from "@/lib/community/testids"
import { useUiHandlers } from "@/stores/community"

function PageKindIcon({ kind }: { kind: "doc" | "slides" | "other" }) {
  if (kind === "doc") return <FileText className="size-5 shrink-0" aria-hidden="true" />
  if (kind === "slides") return <Presentation className="size-5 shrink-0" aria-hidden="true" />
  return <File className="size-5 shrink-0" aria-hidden="true" />
}

export function OpenArtifactCard({
  page,
  onOpen,
  disabled = false,
}: {
  page: AlookPageEmbed
  onOpen?: (page: AlookPageEmbed) => void
  disabled?: boolean
}) {
  const typeInfo = describePageType(page.type)
  return (
    <button
      type="button"
      disabled={disabled}
      data-testid={tid.openArtifactCard(page.id)}
      data-page-type={page.type}
      onClick={() => onOpen?.(page)}
      aria-label={`Open ${typeInfo.label}: ${page.title}`}
      className="group flex min-h-14 w-full max-w-108 items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors duration-150 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted/70 text-foreground/80">
        <PageKindIcon kind={typeInfo.kind} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-foreground">
          {page.title}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {typeInfo.label}
        </span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/80 bg-background/80 px-2.5 py-1 text-xs font-medium text-foreground transition-colors duration-150 group-hover:bg-background motion-reduce:transition-none">
        <span>Open</span>
        <ArrowUpRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </span>
    </button>
  )
}

function RuntimeOpenArtifactCard({
  page,
  disabled = false,
}: {
  page: AlookPageEmbed
  disabled?: boolean
}) {
  const uiHandlers = useUiHandlers()
  return (
    <OpenArtifactCard
      page={page}
      disabled={disabled}
      onOpen={(target) => uiHandlers.openPage?.(target)}
    />
  )
}

export function MessageOpenArtifactCard({
  page,
  onOpenPage,
  disabled = false,
}: {
  page: AlookPageEmbed
  onOpenPage?: (page: AlookPageEmbed) => void
  disabled?: boolean
}) {
  if (onOpenPage) {
    return <OpenArtifactCard page={page} onOpen={onOpenPage} disabled={disabled} />
  }
  return <RuntimeOpenArtifactCard page={page} disabled={disabled} />
}
