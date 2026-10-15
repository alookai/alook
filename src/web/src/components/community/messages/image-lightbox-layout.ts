export type ImageDimensions = { width: number; height: number }

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
