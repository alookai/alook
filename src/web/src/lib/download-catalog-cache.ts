import { unstable_cache } from "next/cache"
import { readDownloadCatalog, type DownloadCatalog } from "./download-catalog"
import { RELEASE_CACHE_SECONDS } from "./github-releases"

class DownloadCatalogUnavailable extends Error {}

const readCachedCatalog = unstable_cache(async () => {
  const catalog = await readDownloadCatalog()
  if (catalog.unavailable) throw new DownloadCatalogUnavailable("download_catalog_unavailable")
  return catalog
}, ["public-download-installers-v1"], { revalidate: RELEASE_CACHE_SECONDS })

export async function readCachedDownloadCatalog(): Promise<DownloadCatalog> {
  try {
    return await readCachedCatalog()
  } catch (error) {
    if (error instanceof DownloadCatalogUnavailable) return { installers: [], unavailable: true }
    console.warn("download_catalog_cache_unavailable")
    return readDownloadCatalog()
  }
}
