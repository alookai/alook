export type MobileBackGesture = {
  update: (progress: number) => void
  complete: () => boolean
  cancel: () => void
  abort: () => void
}
