export type ImageDimensions = { width: number; height: number }
export type RectBounds = { left: number; top: number; width: number; height: number }

export function validImageDimensions(width?: number, height?: number): ImageDimensions | undefined {
  if (
    width === undefined
    || height === undefined
    || !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0
  ) return undefined

  return { width, height }
}

export function isPointInsidePaintedImage({
  point,
  frame,
  natural,
  maxDimensions,
  view,
}: {
  point: { x: number; y: number }
  frame: RectBounds
  natural: ImageDimensions | undefined
  maxDimensions: ImageDimensions | undefined
  view: { scale: number; x: number; y: number }
}): boolean {
  if (frame.width <= 0 || frame.height <= 0 || !natural) return false
  const boxWidth = Math.min(frame.width, maxDimensions?.width ?? frame.width)
  const boxHeight = Math.min(frame.height, maxDimensions?.height ?? frame.height)
  if (boxWidth <= 0 || boxHeight <= 0) return false
  const fitScale = Math.min(boxWidth / natural.width, boxHeight / natural.height)
  const paintedWidth = natural.width * fitScale * view.scale
  const paintedHeight = natural.height * fitScale * view.scale
  const centerX = frame.left + frame.width / 2 + view.x
  const centerY = frame.top + frame.height / 2 + view.y
  return (
    point.x >= centerX - paintedWidth / 2
    && point.x <= centerX + paintedWidth / 2
    && point.y >= centerY - paintedHeight / 2
    && point.y <= centerY + paintedHeight / 2
  )
}
