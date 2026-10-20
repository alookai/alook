"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useCallback, useRef, useState } from "react"
import Cropper, { type Area } from "react-easy-crop"
import { toast } from "sonner"
import { getErrorMessage } from "@/lib/api/client"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Slider, SliderControl, SliderTrack, SliderRange, SliderThumb } from "@/components/ui/slider"
import { ICON_CROP_MIN_ZOOM, ICON_CROP_MAX_ZOOM, ICON_CROP_OUTPUT_SIZE } from "@alook/shared"
import { getCroppedIconBlob, buildCroppedIconFile } from "@/lib/community/image-crop"

/**
 * Shared crop/zoom dialog for server icons (square) and user/bot avatars
 * (circle). Does NOT call `URL.revokeObjectURL` on `imageSrc` — it doesn't
 * own that URL; every caller is responsible for creating and revoking it
 * symmetrically on both the cropped and cancelled paths.
 */
export function ImageCropDialog({
  imageSrc,
  originalFileName,
  maskShape,
  onCancel,
  onCropped,
}: {
  imageSrc: string
  originalFileName: string
  maskShape: "circle" | "square"
  onCancel: () => void
  onCropped: (file: File) => void
}) {
  const [open, setOpen] = useState(true)
  const cropped = useRef<File | null>(null)
  const [crop, setCrop] = useAtom(useCreateAtom({ x: 0, y: 0 }))
  const [zoom, setZoom] = useAtom(useCreateAtom(1))
  const [cropPixels, setCropPixels] = useAtom(useCreateAtom<Area | null>(null))
  const [saving, setSaving] = useAtom(useCreateAtom(false))

  const onCropComplete = useCallback((_area: Area, areaPixels: Area) => {
    setCropPixels(areaPixels)
  }, [setCropPixels])

  const save = async () => {
    if (!cropPixels) return
    setSaving(true)
    try {
      const blob = await getCroppedIconBlob(imageSrc, cropPixels, ICON_CROP_OUTPUT_SIZE)
      if (!blob) {
        toast.error("Failed to process image — please try again")
        return
      }
      cropped.current = buildCroppedIconFile(blob, originalFileName)
      setOpen(false)
    } catch (e) {
      toast.error(getErrorMessage(e, "Failed to process image — please try again"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen} onOpenChangeComplete={(next) => {
      if (next) return
      const file = cropped.current
      cropped.current = null
      if (file) onCropped(file)
      else onCancel()
    }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Crop image</DialogTitle>
        </DialogHeader>
        <div data-base-ui-swipe-ignore="" className="relative h-80 w-full overflow-hidden rounded-md bg-muted">
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={1}
            cropShape={maskShape === "circle" ? "round" : "rect"}
            minZoom={ICON_CROP_MIN_ZOOM}
            maxZoom={ICON_CROP_MAX_ZOOM}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
          />
        </div>
        <Slider
          aria-label="Zoom"
          min={ICON_CROP_MIN_ZOOM}
          max={ICON_CROP_MAX_ZOOM}
          step={0.01}
          value={zoom}
          onValueChange={(v) => setZoom(v as number)}
        >
          <SliderControl>
            <SliderTrack>
              <SliderRange />
              <SliderThumb />
            </SliderTrack>
          </SliderControl>
        </Slider>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={save} disabled={!cropPixels || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
