"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import Image from "next/image"
import { toBlob } from "html-to-image"
import { toast } from "sonner"
import { Check, Copy, Download, Highlighter, Loader2 } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Avatar } from "./avatar"
import { MessageBody } from "./message-body"
import { tid } from "@/lib/community/testids"
import { applyHighlightToRange, clearHighlights, hasHighlights } from "@/lib/community/highlight-range"
import type { RenderMsg } from "./_types"

// Share one OR several messages as an image. Renders a self-contained "share
// card" that mirrors the in-app message blob(s) (avatar / name / content — NO
// timestamp, per spec) plus an Alook brand footer, then rasterises THAT SAME
// node to PNG (WYSIWYG) via html-to-image — fully client-side, no backend. The
// captured node has a fixed width and its own solid background so the export is
// stable regardless of the surrounding theme surface.
//
// Multi-message (Gus uiux #128, Alli #133): pass an array of the selected
// messages (in order). Consecutive same-author messages collapse the avatar/
// name (each carries `grouped`, computed by the message list — reused verbatim),
// exactly like the chat stream. Everything else — toBlob capture, Download/Copy,
// drag-highlight — is shared; highlight is per-message (each body its own ref).
export function MessageShareDialog({ m, open, onClose }: {
  m: RenderMsg | RenderMsg[]
  open: boolean
  onClose: () => void
}) {
  const messages = useMemo(() => (Array.isArray(m) ? m : [m]), [m])
  const cardRef = useRef<HTMLDivElement>(null)
  // One body wrapper per message — highlight operations are scoped to the body
  // the drag happened in, so a drag never wraps the avatar/name/footer OR bleeds
  // across messages (Alli #133: highlight is per-message). Keyed by message id.
  const bodyRefs = useRef(new Map<string, HTMLDivElement | null>())
  const [busy, setBusy] = useState<"copy" | "download" | null>(null)
  const [copied, setCopied] = useState(false)
  // Drives the Reset button's presence. Gus (uiux #95): the button is HIDDEN
  // (not disabled) when there's nothing to reset — "less is more". Mirrors the
  // DOM (any `mark[data-hl]` across the bodies) after each apply/reset.
  const [highlighted, setHighlighted] = useState(false)

  const anyHighlight = useCallback(
    () => [...bodyRefs.current.values()].some((b) => b && hasHighlights(b)),
    [],
  )

  // On mouseup inside a message body, wrap the current selection in a highlight.
  // Text-node-level wrapping (see highlight-range.ts) — never surroundContents,
  // so it survives spanning multiple markdown elements. Drags stack; the browser
  // selection is collapsed afterward so it doesn't also land in the PNG. Scoped
  // to the one body the drag is in — a selection straying outside it is ignored.
  const onBodyMouseUp = useCallback((id: string) => {
    const body = bodyRefs.current.get(id)
    if (!body) return
    const sel = window.getSelection?.()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    if (!body.contains(range.commonAncestorContainer)) return
    const added = applyHighlightToRange(body, range)
    sel.removeAllRanges()
    if (added > 0) setHighlighted(anyHighlight())
  }, [anyHighlight])

  const resetHighlights = useCallback(() => {
    for (const body of bodyRefs.current.values()) if (body) clearHighlights(body)
    setHighlighted(false)
  }, [])

  // Rasterise the card node to a PNG blob. pixelRatio 2 for a crisp image on
  // retina / when pasted into other apps. `cacheBust` avoids stale cross-origin
  // image reuse; the card is same-origin so fonts + the logo embed cleanly.
  const render = async (): Promise<Blob | null> => {
    const node = cardRef.current
    if (!node) return null
    // Guarantee the Caveat brand font is loaded BEFORE rasterising. html-to-image
    // inlines webfonts into the SVG it draws; if Caveat's async @font-face hasn't
    // resolved yet, the footer silently falls back to a default font and the PNG
    // differs machine-to-machine ("fine on mine, blurry/wrong on theirs"). Awaiting
    // the specific face (then the global ready signal) closes that race.
    try {
      if (document.fonts?.load) await document.fonts.load('16px "Caveat"')
      await document.fonts?.ready
    } catch {
      // Font API unavailable / load rejected — proceed; worst case is the
      // footer's fallback font, not a failed export.
    }
    return toBlob(node, {
      pixelRatio: 2,
      // Re-fetch + inline external images (e.g. an uploaded CDN avatar) rather
      // than reusing a possibly-tainted cached bitmap — avoids the canvas-taint
      // path that would drop the avatar from the PNG. Beam fallbacks are our own
      // inline SVG, so they're unaffected either way.
      cacheBust: true,
      // Solid backdrop so the exported PNG never bleeds transparent corners
      // (the card's own rounded bg sits on top of this).
      backgroundColor: getComputedStyle(node).getPropertyValue("--card")?.trim() || undefined,
    })
  }

  const copy = async () => {
    setBusy("copy")
    try {
      const blob = await render()
      if (!blob) throw new Error("render failed")
      // ClipboardItem image write — supported in modern Chromium/Safari/FF.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
      setCopied(true)
      toast.success("Image copied to clipboard")
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      toast.error("Couldn't copy image — try Download instead")
    } finally {
      setBusy(null)
    }
  }

  const download = async () => {
    setBusy("download")
    try {
      const blob = await render()
      if (!blob) throw new Error("render failed")
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `alook-message-${messages[0]?.authorName ?? "share"}.png`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error("Couldn't generate image")
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {/* NOTE: DialogContent's base class carries `sm:max-w-sm` (384px). That's
          a responsive variant, so it sorts AFTER a plain `max-w-[…]` in the
          generated CSS and would silently cap the dialog at 384px — the reason a
          wider `w-*` "doesn't take effect". Override it with a matching `sm:`
          max-width so the width below can actually apply. */}
      <DialogContent className="w-180 max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-2rem)] gap-0 p-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>{messages.length > 1 ? `Share ${messages.length} messages` : "Share message"}</DialogTitle>
        </DialogHeader>

        {/* Preview area — the padding frames the card; the card itself is what
            gets captured. Scrolls when the card is tall (many messages, Alli
            #137): only the PREVIEW is height-bounded + scrollable — `toBlob`
            captures `cardRef` (the full card), so the export is never cut by
            this scroll bound. */}
        <div className="max-h-[60vh] overflow-y-auto bg-muted/40 px-6 py-6">
          {/* The card takes the full preview width — a generous, poster-like
              default so the share image reads as a proper card at any content
              length. The CARD itself is NOT height-capped: the exported PNG is
              the full card (Alli #137). Runaway height is bounded PER MESSAGE
              (each body clamps at 32 lines, below), and the PREVIEW container
              (the wrapper above) scrolls — so a many-message selection is fully
              exported but doesn't blow the popup out. */}
          <div
            ref={cardRef}
            className="rounded-xl bg-card p-5 shadow-(--e1)"
          >
            {messages.map((msg) => (
              // A grouped message (consecutive same author) collapses the avatar
              // column into a spacer + drops the name, matching the chat stream.
              <div key={msg.id} className={`flex gap-3 ${msg.grouped ? "mt-0.5" : "mt-3 first:mt-0"}`}>
                {msg.grouped
                  ? <div className="w-10 shrink-0" aria-hidden />
                  : <Avatar label={msg.authorAvatar ?? "?"} seed={msg.authorId} size={40} />}
                <div className="min-w-0 flex-1">
                  {!msg.grouped && (
                    <div
                      className="mb-0.5 text-[15px] font-semibold"
                      style={{ color: msg.color ?? "var(--foreground)" }}
                    >
                      {msg.authorName}
                    </div>
                  )}
                  {/* Each body: clamp at 32 lines (Alli #137 — one number for
                      single & multi share). Two layers, same as the original
                      single-message card: `max-h` hard-bounds any structure
                      (multi-paragraph markdown escapes line-clamp alone), and
                      `line-clamp-[32]` gives a single-block message a tidy
                      ellipsis. Each body also drives its own drag-highlight
                      (per-message scope, Alli #133) via its ref in `bodyRefs`;
                      the `mark[data-hl]` styles are the soft-yellow marker
                      (rasterises cleanly under html-to-image — plain bg +
                      box-decoration-break, no mask). max-h ≈ 32 lines at the
                      body's 15px/leading-snug. */}
                  {msg.content && (
                    <div
                      ref={(el) => { bodyRefs.current.set(msg.id, el) }}
                      onMouseUp={() => onBodyMouseUp(msg.id)}
                      className="max-h-[41rem] overflow-hidden line-clamp-[32] [&_mark[data-hl]]:bg-[rgba(255,208,92,0.5)] [&_mark[data-hl]]:[border-radius:2px] [&_mark[data-hl]]:[padding:0_1px] [&_mark[data-hl]]:[box-decoration-break:clone] [&_mark[data-hl]]:[-webkit-box-decoration-break:clone] [&_mark[data-hl]]:text-inherit"
                    >
                      <MessageBody text={msg.content} />
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Brand footer — Alook logo + brand font, mirrors the marketing
                footer treatment. One footer for the whole card, single or multi. */}
            <div className="mt-4 flex items-center gap-1.5 border-t border-border/50 pt-3">
              <Image src="/alook.svg" alt="" width={16} height={16} />
              <span
                className="text-sm font-bold tracking-tight text-muted-foreground"
                style={{ fontFamily: "var(--font-brand)" }}
              >
                Alook
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-5 pt-3 pb-5">
          {/* Left slot: Reset highlight — MOUNTED only when a highlight exists
              (Gus uiux #95: appears when useful, not a disabled ghost). Empty
              slot otherwise keeps Download/Copy right-aligned. */}
          <div>
            {highlighted && (
              <Button variant="ghost" size="sm" onClick={resetHighlights} disabled={busy !== null}>
                <Highlighter />
                Reset highlight
              </Button>
            )}
          </div>
          <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={download} disabled={busy !== null}>
            {busy === "download" ? <Loader2 className="animate-spin" /> : <Download />}
            Download
          </Button>
          <Button
            size="sm"
            data-testid={tid.messageShareCopy}
            onClick={copy}
            disabled={busy !== null}
          >
            {busy === "copy" ? <Loader2 className="animate-spin" /> : copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy image"}
          </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
