import { getCloudflareContext } from "@opennextjs/cloudflare"
import { NextResponse } from "next/server"
import { compareVersions, parseStableSemver, RELEASE_CACHE_SECONDS } from "@/lib/github-releases"
import { isDesktopUpdaterPlatformKey, readReleaseManifestFromKv } from "@/lib/release-manifest"

const CACHE_TTL = RELEASE_CACHE_SECONDS

function unavailableResponse() {
  return NextResponse.json(
    { error: "Release manifest unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  )
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ target: string; arch: string; current_version: string }> },
) {
  const { target, arch, current_version } = await params
  const bundleType = new URL(req.url).searchParams.get("bundle_type")
  const platformKey = `${target}-${arch}-${bundleType}`
  const currentVersion = parseStableSemver(current_version)
  if (!isDesktopUpdaterPlatformKey(platformKey) || !currentVersion) {
    return new NextResponse(null, { status: 204 })
  }

  let kv: KVNamespace | undefined
  try {
    const { env } = await getCloudflareContext({ async: true })
    kv = env.CACHE_KV
  } catch {
    console.warn("desktop_updater_unavailable", { stage: "context" })
    return unavailableResponse()
  }

  if (!kv) {
    console.warn("desktop_updater_unavailable", { stage: "binding" })
    return unavailableResponse()
  }

  const result = await readReleaseManifestFromKv(kv)
  if (result.status !== "ok") {
    if (result.status === "corrupt") {
      console.warn("desktop_updater_unavailable", { stage: "manifest", reason: result.reason })
    } else if (result.status === "error") {
      console.warn("desktop_updater_unavailable", { stage: "kv", error_kind: result.errorKind })
    }
    return unavailableResponse()
  }

  const { desktopUpdater } = result.manifest
  if (!desktopUpdater) {
    return unavailableResponse()
  }

  const latestVersion = parseStableSemver(desktopUpdater.version)
  if (!latestVersion || compareVersions(latestVersion, currentVersion) <= 0) {
    return new NextResponse(null, { status: 204 })
  }

  const platformEntry = desktopUpdater.platforms[platformKey]
  if (!platformEntry) {
    return new NextResponse(null, { status: 204 })
  }

  return NextResponse.json(
    {
      version: desktopUpdater.version,
      notes: desktopUpdater.notes,
      pub_date: desktopUpdater.pub_date,
      platforms: {
        [platformKey]: {
          url: platformEntry.url,
          signature: platformEntry.signature,
        },
      },
    },
    {
      headers: { "Cache-Control": `public, max-age=${CACHE_TTL}` },
    },
  )
}
