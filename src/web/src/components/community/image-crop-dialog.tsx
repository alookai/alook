"use client"

import { useCallback, useState } from "react"
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
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [cropPixels, setCropPixels] = useState<Area | null>(null)
  const [saving, setSaving] = useState(false)

  const onCropComplete = useCallback((_area: Area, areaPixels: Area) => {
    setCropPixels(areaPixels)
  }, [])

  const save = async () => {
    if (!cropPixels) return
    setSaving(true)
    try {
      const blob = await getCroppedIconBlob(imageSrc, cropPixels, ICON_CROP_OUTPUT_SIZE)
      if (!blob) {
        toast.error("Failed to process image — please try again")
        return
      }
      onCropped(buildCroppedIconFile(blob, originalFileName))
    } catch (e) {
      toast.error(getErrorMessage(e, "Failed to process image — please try again"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Crop image</DialogTitle>
        </DialogHeader>
        <div className="relative h-80 w-full overflow-hidden rounded-md bg-muted">
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
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button onClick={save} disabled={!cropPixels || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
