// Photo-avatar detection + the dual-mode draft used by the bot picker. These
// outlived the procedural avatar engine (removed in favor of boring-avatars):
// a stored avatar value is either a real photo URL or a `avatar:beam:{seed}`.

export function isPhotoAvatarUrl(url: string | null | undefined): boolean {
  return !!url && (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/"));
}

// `file` is null when re-opening an existing photo untouched (edit); a real
// `File` once freshly cropped this session.
export type AvatarDraft =
  | { kind: "procedural"; image: string }
  | { kind: "photo"; file: File | null; previewUrl: string };
