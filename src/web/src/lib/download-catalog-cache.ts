import { getCloudflareContext } from "@opennextjs/cloudflare"
import type { DownloadCatalog } from "./download-catalog"
import { readReleaseManifestFromKv } from "./release-manifest"

export async function readCachedDownloadCatalog(): Promise<DownloadCatalog> {
  let kv: KVNamespace | undefined
  try {
    const { env } = await getCloudflareContext({ async: true })
    kv = env.CACHE_KV
  } catch {
    console.warn("download_catalog_unavailable", { stage: "context" })
    return { installers: [], unavailable: true }
  }

  if (!kv) {
    console.warn("download_catalog_unavailable", { stage: "binding" })
    return { installers: [], unavailable: true }
  }

  const result = await readReleaseManifestFromKv(kv)
  if (result.status === "ok") {
    return { installers: result.manifest.installers, unavailable: false }
  }

  if (result.status === "corrupt") {
    console.warn("download_catalog_unavailable", { stage: "manifest", reason: result.reason })
  } else if (result.status === "error") {
    console.warn("download_catalog_unavailable", { stage: "kv", error_kind: result.errorKind })
  }

  return { installers: [], unavailable: true }
}
