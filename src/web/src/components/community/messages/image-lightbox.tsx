"use client"

import { useState } from "react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import type { ImagePreview } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"

// Full-screen image preview. Uses shadcn Dialog for accessibility (focus trap, Esc, aria).
export function ImageLightbox({ image, onClose }: { image: ImagePreview; onClose: () => void }) {
  const [originalLoaded, setOriginalLoaded] = useState(false)
  const [originalFailed, setOriginalFailed] = useState(false)
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent
        className="flex max-h-[90vh] w-auto sm:max-w-none items-center justify-center border-none bg-transparent p-0 shadow-none"
        showCloseButton={false}
      >
        <div data-testid={tid.imageLightbox} className="grid max-h-[85vh] max-w-[90vw] place-items-center">
          {image.thumbnailUrl && (
            <img data-testid={tid.imageLightboxThumbnail} src={image.thumbnailUrl} alt={image.name} className="col-start-1 row-start-1 max-h-[85vh] max-w-[90vw] rounded-lg object-contain" />
          )}
          {!originalFailed && (
            <img
              data-testid={tid.imageLightboxOriginal}
              src={image.originalUrl}
              alt={image.name}
              onLoad={() => setOriginalLoaded(true)}
              onError={() => setOriginalFailed(true)}
              className={`col-start-1 row-start-1 max-h-[85vh] max-w-[90vw] rounded-lg object-contain ${originalLoaded || !image.thumbnailUrl ? "opacity-100" : "invisible opacity-0"}`}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
