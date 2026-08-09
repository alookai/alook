/** A persisted photo avatar is always a remote or app-routable URL. */
export function isPhotoAvatarUrl(value: string | null | undefined): boolean {
  return !!value && (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("/"))
}

// `file` is null when re-opening an existing photo untouched; it is populated
// after a freshly selected photo has been cropped in the current session.
export type AvatarDraft =
  | { kind: "procedural"; image: string }
  | { kind: "photo"; file: File | null; previewUrl: string }
