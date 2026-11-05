import type { Metadata } from "next"
import { BrandVisual } from "./brand-visual"

export const metadata: Metadata = {
  title: "Brand visual — Alook",
  robots: { index: false, follow: false },
}

export default function BrandVisualPage() {
  return <BrandVisual />
}
