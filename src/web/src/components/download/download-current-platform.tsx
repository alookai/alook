"use client"

import { useEffect } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { ArrowDown, ArrowUpRight } from "lucide-react"
import { IOS_TESTFLIGHT_URL, currentDownloadTargets, downloadArchitecture, downloadPlatformFromOS, UNKNOWN_DOWNLOAD_ENVIRONMENT, type DownloadEnvironment, type DownloadInstaller } from "@/lib/download-platforms"
import styles from "./download-page.module.css"

type ClientHints = {
  platform: string
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; bitness?: string }>
}

const LABELS = {
  "mac-arm": "Download for Mac",
  "mac-intel": "Download for Mac",
  "windows-exe": "Download for Windows",
  "windows-msi": "Download for Windows",
  "linux-appimage": "Download for Linux",
  "linux-deb": "Download for Linux",
  "linux-rpm": "Download for Linux",
  "android-apk": "Download for Android",
} as const

export function DownloadCurrentPlatform({ installers, initialEnvironment = UNKNOWN_DOWNLOAD_ENVIRONMENT }: { installers: DownloadInstaller[]; initialEnvironment?: DownloadEnvironment }) {
  const [environment, setEnvironment] = useAtom(useCreateAtom(initialEnvironment))
  useEffect(() => {
    let current = true
    const hints = (navigator as Navigator & { userAgentData?: ClientHints }).userAgentData
    const hintedPlatform = downloadPlatformFromOS(hints?.platform)
    const platform = initialEnvironment.platform === "macos" && navigator.maxTouchPoints > 1
      ? "ios" : hintedPlatform === "unknown" ? initialEnvironment.platform : hintedPlatform
    const fallback: DownloadEnvironment = { platform, architecture: platform === initialEnvironment.platform ? initialEnvironment.architecture : "unknown" }
    setEnvironment(fallback)
    if (hints?.getHighEntropyValues) {
      void hints.getHighEntropyValues(["architecture", "bitness"]).then(values => {
        if (current) setEnvironment({ platform, architecture: values.architecture ? downloadArchitecture(values.architecture, values.bitness) : fallback.architecture })
      }).catch(() => {})
    }
    return () => { current = false }
  }, [initialEnvironment, setEnvironment])
  const targets = currentDownloadTargets(environment)
  const available = targets.flatMap(id => installers.find(installer => installer.id === id) ?? [])
  const chooseChip = environment.platform === "macos" && environment.architecture === "unknown"
  const choices = chooseChip ? available : available.slice(0, 1)
  if (choices.length) return <>{choices.map(installer => <a key={installer.id} className={styles.primary} href={installer.url}><ArrowDown size={18} aria-hidden="true" />{chooseChip ? installer.id === "mac-arm" ? "Mac · Apple Silicon" : "Mac · Intel" : LABELS[installer.id]}</a>)}</>
  if (environment.platform === "ios") return <a className={styles.primary} href={IOS_TESTFLIGHT_URL}>Join the beta<ArrowUpRight size={18} aria-hidden="true" /></a>
  return <a className={styles.primary} href="#desktop"><ArrowDown size={18} aria-hidden="true" />Choose your platform</a>
}
