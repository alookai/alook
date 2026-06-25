declare module "@emoji-mart/react" {
  import type { ComponentType } from "react"
  export interface PickerProps {
    data?: unknown
    onEmojiSelect?: (emoji: { native: string; id: string }) => void
    theme?: "auto" | "light" | "dark"
    set?: string
    skinTonePosition?: string
    previewPosition?: string
    [key: string]: unknown
  }
  const Picker: ComponentType<PickerProps>
  export default Picker
}

declare module "@emoji-mart/data" {
  const data: unknown
  export default data
}
