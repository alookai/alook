"use client"

import { useRef, useState } from "react"
import Image from "next/image"
import { toBlob } from "html-to-image"
import { toast } from "sonner"
import { Check, Copy, Download, Loader2 } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Avatar } from "./avatar"
import { MessageBody } from "./message-body"
import { tid } from "@/lib/community/testids"
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
  const [busy, setBusy] = useState<"copy" | "download" | null>(null)
  const [copied, setCopied] = useState(false)

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
                {m.content && <MessageBody text={m.content} />}
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

        <div className="flex justify-end gap-2 px-5 pt-3 pb-5">
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
      </DialogContent>
    </Dialog>
  )
}
