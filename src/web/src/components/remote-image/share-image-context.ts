"use client"

import { createContext, useContext } from "react"

export const ShareImagePreparationContext = createContext(false)

export function useShareImageSource(src: string) {
  return useContext(ShareImagePreparationContext)
    ? { "data-share-image-src": src, srcSet: undefined }
    : { src }
}
