import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

const tarball = path.resolve(process.argv[2] ?? "")
assert(fs.existsSync(tarball), `tarball not found: ${tarball}`)
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "alook-daemon-thumbnail-smoke-"))

try {
  execFileSync("npm", ["install", "--ignore-scripts=false", tarball], { cwd: temp, stdio: "inherit" })
  const installedPackage = JSON.parse(fs.readFileSync(path.join(temp, "node_modules/@alook/daemon/package.json"), "utf8"))
  assert(installedPackage.dependencies?.sharp, "packed daemon must declare sharp as a runtime dependency")

  const png = path.join(temp, "valid.png")
  const requireFromDaemon = createRequire(path.join(temp, "node_modules/@alook/daemon/package.json"))
  const sharp = requireFromDaemon("sharp")
  await sharp({
    create: { width: 1200, height: 800, channels: 3, background: "#336699" },
  }).png().toFile(png)
  const originalSize = fs.statSync(png).size
  const token = path.join(temp, "voucher")
  fs.writeFileSync(token, "crk_smoke", { mode: 0o600 })

  let resolveBody
  const bodyPromise = new Promise((resolve) => { resolveBody = resolve })
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      resolveBody({ body: Buffer.concat(chunks), contentType: req.headers["content-type"] ?? "" })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "att_smoke", filename: "valid.png", contentType: "image/png", size: originalSize, hasThumbnail: true }))
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address === "object")
  const cli = path.join(temp, "node_modules/@alook/daemon/dist/cli/index.js")
  const child = spawn(process.execPath, [cli, "message", "attachment", "upload", "--target", "/demo#1234/general", "--file", png], {
    env: {
      ...process.env,
      ALOOK_PROXY_URL: `http://127.0.0.1:${address.port}`,
      ALOOK_PROXY_TOKEN_FILE: token,
      ALOOK_AGENT_ID: "agent_smoke",
    },
  })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
  const status = await new Promise((resolve) => child.on("close", resolve))
  server.close()
  assert.equal(status, 0, stderr)
  assert.deepEqual(JSON.parse(stdout), {
    success: { id: "att_smoke", filename: "valid.png", contentType: "image/png", size: originalSize, hasThumbnail: true },
  })

  const { body, contentType } = await bodyPromise
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1]
  assert(boundary, "multipart boundary missing")
  const binary = body.toString("latin1")
  assert(binary.includes('name="file"; filename="valid.png"'))
  assert(binary.includes('name="thumbnail"; filename="thumbnail.jpg"'))
  assert(binary.includes("Content-Type: image/jpeg"))
  assert(binary.includes('name="width"\r\n\r\n1200'))
  assert(binary.includes('name="height"\r\n\r\n800'))
  const thumbnailStart = binary.indexOf('name="thumbnail"')
  const payloadStart = binary.indexOf("\r\n\r\n", thumbnailStart) + 4
  const payloadEnd = binary.indexOf(`\r\n--${boundary}`, payloadStart)
  const thumbnail = body.subarray(payloadStart, payloadEnd)
  assert(thumbnail.length <= 512 * 1024)
  assert.deepEqual([...thumbnail.subarray(0, 2)], [0xff, 0xd8])
  assert.deepEqual([...thumbnail.subarray(-2)], [0xff, 0xd9])
  const thumbnailMetadata = await sharp(thumbnail).metadata()
  assert(Math.max(thumbnailMetadata.width ?? 0, thumbnailMetadata.height ?? 0) <= 1024)
  process.stdout.write("daemon thumbnail pack smoke passed\n")
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
