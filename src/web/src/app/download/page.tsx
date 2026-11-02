import { headers } from "next/headers"
import { userAgent } from "next/server"
import { DownloadPageView } from "@/components/download/download-page"
import { readDownloadCatalog } from "@/lib/download-catalog"
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata"
import { downloadArchitecture, downloadPlatformFromOS } from "@/lib/download-platforms"

export const metadata = buildPublicPageMetadata({
  title: "Download Alook — macOS, Windows, Linux & Android",
  description: "Get Alook for your computer or Android phone, or open it in your browser. Your team, friends and agents, together on every screen.",
  path: "/download",
})

export default async function DownloadPage() {
  const agent = userAgent({ headers: await headers() })
  const platform = downloadPlatformFromOS(agent.os.name)
  const architecture = platform === "macos" ? "unknown" : downloadArchitecture(agent.cpu.architecture)
  return <DownloadPageView catalog={await readDownloadCatalog()} initialEnvironment={{ platform, architecture }} />
}
