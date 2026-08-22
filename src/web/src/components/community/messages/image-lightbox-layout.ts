export type ImageDimensions = { width: number; height: number }

export type ViewportDimensions = { width: number; height: number }

export type PreviewFrameStyle = {
  width: string
  aspectRatio: string
}

const DEFAULT_PREVIEW_EDGE = 200
const PREVIEW_MAX_WIDTH_RATIO = 0.9
const PREVIEW_MAX_HEIGHT_RATIO = 0.85

function formatCssNumber(value: number): string {
  return Number(value.toFixed(6)).toString()
}

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
  const maxWidth = Math.max(1, viewport.width * PREVIEW_MAX_WIDTH_RATIO)
  const maxHeight = Math.max(1, viewport.height * PREVIEW_MAX_HEIGHT_RATIO)
  const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height)

  return {
    width: image.width * scale,
    height: image.height * scale,
  }
}

export function fallbackPreviewSize(viewport: ViewportDimensions): ImageDimensions {
  const edge = Math.min(
    DEFAULT_PREVIEW_EDGE,
    Math.max(1, viewport.width * PREVIEW_MAX_WIDTH_RATIO),
    Math.max(1, viewport.height * PREVIEW_MAX_HEIGHT_RATIO),
  )
  return { width: edge, height: edge }
}

/**
 * CSS owns live viewport fitting so resize and orientation changes do not need
 * client-side viewport snapshots or event listeners. The height-limited width
 * is expressed in vh after applying the image aspect ratio.
 */
export function previewFrameStyle(dimensions?: ImageDimensions): PreviewFrameStyle {
  if (!dimensions) {
    return {
      width: `min(${DEFAULT_PREVIEW_EDGE}px, ${PREVIEW_MAX_WIDTH_RATIO * 100}vw, ${PREVIEW_MAX_HEIGHT_RATIO * 100}vh)`,
      aspectRatio: "1 / 1",
    }
  }

  const heightLimitedWidth = PREVIEW_MAX_HEIGHT_RATIO * 100 * (dimensions.width / dimensions.height)
  return {
    width: `min(${formatCssNumber(dimensions.width)}px, ${PREVIEW_MAX_WIDTH_RATIO * 100}vw, ${formatCssNumber(heightLimitedWidth)}vh)`,
    aspectRatio: `${formatCssNumber(dimensions.width)} / ${formatCssNumber(dimensions.height)}`,
  }
}
