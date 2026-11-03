import text from "./message.txt"
import bytes from "./sample.bin"
import wasm from "./empty.wasm"
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/api") return Response.json({ message: env.MESSAGE, text, bytes: bytes.byteLength, wasmExports: Object.keys(new WebAssembly.Instance(wasm).exports), bindings: Object.keys(env).sort() })
    return env.ASSETS.fetch(request)
  }
}
