import { createSerwistRoute } from "@serwist/turbopack"
import { isPublicAssetPath } from "@/lib/service-worker/public-cache"

const serviceWorkerRoute = createSerwistRoute({
  swSrc: "src/app/sw.ts",
  useNativeEsbuild: true,
  globPatterns: [
    ".next/static/chunks/**/*.{js,css}",
    ".next/static/media/*.{woff,woff2}",
    "public/alook.svg",
    "public/official-server-badge-flat.svg",
    "public/apple-touch-icon.png",
    "public/icon-192.png",
    "public/icon-512.png",
  ],
  maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
  manifestTransforms: [async entries => ({
    manifest: entries.filter(entry => isPublicAssetPath(
      entry.url.replace(/^\.next\//, "/_next/").replace(/^public\//, "/"),
    )),
    warnings: [],
  })],
  esbuildOptions: { format: "iife", sourcemap: false, define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV) } },
})

export const generateStaticParams = serviceWorkerRoute.generateStaticParams

export async function GET(request: Request, context: { params: Promise<{ path: string }> }) {
  const response = await serviceWorkerRoute.GET(request, context)
  response.headers.set("Cache-Control", "no-cache")
  response.headers.set("X-Content-Type-Options", "nosniff")
  return response
}

export const dynamic = "force-static"
export const dynamicParams = false
export const revalidate = false
