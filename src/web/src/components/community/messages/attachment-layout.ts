export function attachmentAspectRatio(
  width: number | undefined,
  height: number | undefined,
): string {
  return width && height ? `${width}/${height}` : "auto"
}

export function attachmentImageFrameStyle(
  width: number | undefined,
  height: number | undefined,
  loaded?: { width: number; height: number },
): { width: string; aspectRatio: string } {
  if (loaded && loaded.width > 0 && loaded.height > 0) {
    const originalWidth = width && height && width > 0 && height > 0 ? `${width}px, ` : ""
    return {
      width: `min(100%, ${originalWidth}calc(var(--attachment-image-max-height, 200px) * ${loaded.width} / ${loaded.height}))`,
      aspectRatio: `${loaded.width}/${loaded.height}`,
    }
  }
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
