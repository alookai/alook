import type { Metadata } from "next"
import styles from "@/components/home/landing-interactive-shell.module.css"
import tn from "@/components/brand/technostalgia.module.css"
import LandingInteractiveShell from "@/components/home/landing-interactive-shell"

export const metadata: Metadata = { title: "Alook", robots: { index: false, follow: false } }

/* `?tn=light|dark` pins the demo workspace to one mode for /brand-visual;
 * the theme itself is global (root layout). */
export default async function DemoPage({ searchParams }: { searchParams: Promise<{ tn?: string }> }) {
  const { tn: mode } = await searchParams
  const themed = mode === "light" || mode === "dark"
  return (
    <div className={themed ? `${styles.previewRoot} ${tn.theme} ${tn.page}` : styles.previewRoot} data-tn-mode={themed ? mode : undefined}>
      <LandingInteractiveShell />
    </div>
  )
}
