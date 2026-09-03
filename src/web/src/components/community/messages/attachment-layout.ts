export function attachmentAspectRatio(
  width: number | undefined,
  height: number | undefined,
): string {
  return width && height ? `${width}/${height}` : "auto"
}

export function attachmentImageFrameStyle(
  width: number | undefined,
  height: number | undefined,
): { width: string; aspectRatio: string } | undefined {
  if (!width || !height || width <= 0 || height <= 0) return undefined
  const constrainedWidth = Math.min(width, 300 * width / height)
  const roundedWidth = Math.round(constrainedWidth * 1000) / 1000
  return {
    width: `min(100%, ${roundedWidth}px)`,
    aspectRatio: `${width}/${height}`,
  }
}
