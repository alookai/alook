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
    return {
      width: "min(100%, calc(var(--attachment-image-max-height, 200px) * 4 / 3))",
      aspectRatio: "4/3",
    }
  }
  return {
    width: `min(100%, ${width}px, calc(var(--attachment-image-max-height, 200px) * ${width} / ${height}))`,
    aspectRatio: `${width}/${height}`,
  }
}
