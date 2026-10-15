export type ImageDimensions = { width: number; height: number }

export type ViewportDimensions = { width: number; height: number }

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

export function fitImageToViewport(
  image: ImageDimensions,
  viewport: ViewportDimensions,
): ImageDimensions {
  const maxWidth = Math.max(1, viewport.width)
  const maxHeight = Math.max(1, viewport.height)
  const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height)

  return {
    width: image.width * scale,
    height: image.height * scale,
  }
}
