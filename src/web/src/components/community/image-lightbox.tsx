"use client"

import { Image as ImageIcon } from "lucide-react"
import { Dialog, DialogContent } from "@/components/ui/dialog"

// Full-screen image preview. Uses shadcn Dialog for accessibility (focus trap, Esc, aria).
export function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const isUrl = src.startsWith("http://") || src.startsWith("https://") || src.startsWith("/")
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent
        className="flex max-h-[90vh] w-auto sm:max-w-none items-center justify-center border-none bg-transparent p-0 shadow-none"
        showCloseButton={false}
      >
        {isUrl ? (
          <img src={src} alt="Preview" className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain" />
        ) : (
          <div className="flex aspect-16/10 w-120 flex-col items-center justify-center gap-2 rounded-lg bg-muted text-muted-foreground">
            <ImageIcon className="size-16" />
            <span className="text-sm">{src}</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
