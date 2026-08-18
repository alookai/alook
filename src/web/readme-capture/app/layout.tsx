import type { ReactNode } from "react"
import { caveat, dmMono, dmSans, instrumentSerif, literata, vt323 } from "@/app/fonts"
import "./globals.css"

export default function ReadmeCaptureLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${dmMono.variable} ${instrumentSerif.variable} ${caveat.variable} ${vt323.variable} ${literata.variable} h-full antialiased`}
    >
      <body>{children}</body>
    </html>
  )
}
