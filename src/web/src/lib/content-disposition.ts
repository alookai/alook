export function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function contentDisposition(disposition: "inline" | "attachment", filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_").trim() || "download"
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`
}
