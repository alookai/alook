import type { IncomingMessage, ServerResponse } from "node:http"
import { HTML_PREVIEW_CSP } from "../../web/src/lib/community/html-attachment-preview.ts"

type PreviewServer = {
  use(handler: (request: IncomingMessage, response: ServerResponse, next: () => void) => void): unknown
}

export function experimental_devServer(server: PreviewServer) {
  server.use((request, response, next) => {
    const pathname = request.url?.split("?")[0]
    if (pathname === "/preview/attachment.html") response.setHeader("Content-Security-Policy", HTML_PREVIEW_CSP)
    if (pathname !== "/demo") return next()
    response.writeHead(302, { Location: "/iframe.html?id=web-pages-public-pages--community-demo&viewMode=story" })
    response.end()
  })
  return server
}
