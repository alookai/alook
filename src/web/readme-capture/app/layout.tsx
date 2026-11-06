import type { ReactNode } from "react"
import { caveat, dmMono, dmSans, instrumentSerif, literata, vt323 } from "@/app/fonts"
import technostalgia from "@/components/brand/technostalgia.module.css"
import "./globals.css"

export default function ReadmeCaptureLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-tn-mode="light"
      className={`${dmSans.variable} ${dmMono.variable} ${instrumentSerif.variable} ${caveat.variable} ${vt323.variable} ${literata.variable} h-full antialiased`}
    >
      <body className={technostalgia.theme}>{children}</body>
    </html>
  )
}
