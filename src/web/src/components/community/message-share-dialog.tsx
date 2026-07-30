"use client"

import { useCallback, useRef, useState } from "react"
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

// Share a single message as an image. Renders a self-contained "share card"
// that mirrors the in-app message blob (avatar / name / content — NO timestamp,
// per spec) plus an Alook brand footer, then rasterises THAT SAME node to PNG
// (WYSIWYG) via html-to-image — fully client-side, no backend. The captured
// node has a fixed width and its own solid background so the export is stable
// regardless of the surrounding theme surface.
export function MessageShareDialog({ m, open, onClose }: {
  m: RenderMsg
  open: boolean
  onClose: () => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  // The message-body wrapper — highlight operations are scoped to it so a drag
  // can never wrap the avatar/name/footer, only the message text.
  const bodyRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState<"copy" | "download" | null>(null)
  const [copied, setCopied] = useState(false)
  // Drives the Reset button's presence. Gus (uiux #95): the button is HIDDEN
  // (not disabled) when there's nothing to reset — "less is more". Mirrors the
  // DOM (`mark[data-hl]` count) after each apply/reset.
  const [highlighted, setHighlighted] = useState(false)

  // On mouseup inside the body, wrap the current selection in a highlight.
  // Text-node-level wrapping (see highlight-range.ts) — never surroundContents,
  // so it survives spanning multiple markdown elements. Drags stack; the
  // browser selection is collapsed afterward so it doesn't also land in the PNG.
  const onBodyMouseUp = useCallback(() => {
    const body = bodyRef.current
    if (!body) return
    const sel = window.getSelection?.()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    // Ignore selections that stray outside the message body.
    if (!body.contains(range.commonAncestorContainer)) return
    const added = applyHighlightToRange(body, range)
    sel.removeAllRanges()
    if (added > 0) setHighlighted(hasHighlights(body))
  }, [])

  const resetHighlights = useCallback(() => {
    const body = bodyRef.current
    if (!body) return
    clearHighlights(body)
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
      a.download = `alook-message-${m.authorName ?? "share"}.png`
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
          <DialogTitle>Share message</DialogTitle>
        </DialogHeader>

        {/* Preview area — the padding frames the card; the card itself is what
            gets captured. */}
        <div className="bg-muted/40 px-6 py-6">
          {/* The card takes the full preview width — a generous, poster-like
              default so the share image reads as a proper card at any content
              length (a short message just has more breathing room, rather than
              collapsing to a narrow chip). */}
          <div
            ref={cardRef}
            className="overflow-hidden rounded-xl bg-card p-5 shadow-(--e1)"
          >
            <div className="flex gap-3">
              <Avatar label={m.authorAvatar ?? "?"} seed={m.authorId} size={40} />
              <div className="min-w-0 flex-1">
                <div
                  className="mb-0.5 text-[15px] font-semibold"
                  style={{ color: m.color ?? "var(--foreground)" }}
                >
                  {m.authorName}
                </div>
                {/* Cap the message body so a very long message can't blow the
                    card (and the popup) out vertically (Alli's spec, uiux #38;
                    24 lines per Gus #37). Two layers:
                    • Primary bound = `max-h` + `overflow-hidden`. line-clamp
                      alone only clamps WITHIN one block, so multi-paragraph
                      markdown (the actual bug case) would escape it — the
                      max-height hard-bounds any structure (paragraphs, code,
                      lists) and rasterises cleanly through html-to-image.
                    • `line-clamp-[24]` is the enhancement: a single-paragraph
                      message gets a tidy trailing ellipsis; multi-block content
                      is still caught by max-h (clean cut, no ellipsis — bounded
                      is the bar). No gradient fade — masks rasterise
                      unreliably in html-to-image.
                    Clamped inside cardRef so the PNG matches the preview; the
                    avatar/name/footer sit outside this box and stay complete.
                    max-h ≈ 24 lines at the body's 15px/leading-snug. */}
                {m.content && (
                  <div
                    ref={bodyRef}
                    onMouseUp={onBodyMouseUp}
                    className="max-h-[31rem] overflow-hidden line-clamp-[24] [&_mark[data-hl]]:bg-[rgba(255,208,92,0.5)] [&_mark[data-hl]]:[border-radius:2px] [&_mark[data-hl]]:[padding:0_1px] [&_mark[data-hl]]:[box-decoration-break:clone] [&_mark[data-hl]]:[-webkit-box-decoration-break:clone] [&_mark[data-hl]]:text-inherit"
                  >
                    <MessageBody text={m.content} />
                  </div>
                )}
              </div>
            </div>

            {/* Brand footer — Alook logo + brand font, mirrors the marketing
                footer treatment. */}
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
