export function attachmentAspectRatio(
  width: number | undefined,
  height: number | undefined,
): string {
  return width && height ? `${width}/${height}` : "auto"
}
