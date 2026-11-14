import { vi } from "vitest"

export function createImagesBindingStub() {
  return { input: vi.fn((body: ReadableStream<Uint8Array>) => {
    const transformer: ImageTransformer = {
      transform: () => transformer,
      draw: () => transformer,
      output: async () => {
        await new Response(body).arrayBuffer()
        return {
          response: options => new Response("derived-image", { headers: { "Content-Type": "image/webp", ...Object.fromEntries(new Headers(options?.headers)) } }),
          contentType: () => "image/webp",
          image: () => new Response("derived-image").body!,
        }
      },
    }
    return transformer
  }) }
}
