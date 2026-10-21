import type { Metadata } from "next"
import styles from "@/components/home/landing-interactive-shell.module.css"
import LandingInteractiveShell from "@/components/home/landing-interactive-shell"

export const metadata: Metadata = { title: "Alook", robots: { index: false, follow: false } }

export default function DemoPage() {
  return <div className={styles.previewRoot}><LandingInteractiveShell /></div>
}
