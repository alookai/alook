export function attachmentAspectRatio(
  width: number | undefined,
  height: number | undefined,
): string {
  return width && height ? `${width}/${height}` : "auto"
}

export function attachmentImageFrameStyle(
  width: number | undefined,
  height: number | undefined,
): { width: string; aspectRatio: string } {
  if (!width || !height || width <= 0 || height <= 0) {
    return { width: "min(100%, 300px)", aspectRatio: "4/3" }
  }
  const constrainedWidth = Math.min(width, 300 * width / height)
  const roundedWidth = Math.round(constrainedWidth * 1000) / 1000
  return {
    width: `min(100%, ${roundedWidth}px)`,
    aspectRatio: `${width}/${height}`,
  }
}
