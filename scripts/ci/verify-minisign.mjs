import { createHash, createPublicKey, verify } from "node:crypto"
import { createReadStream, lstatSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

export function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith("--") || value == null) throw new Error(`Invalid argument: ${key ?? "<missing>"}`)
    args[key.slice(2)] = value
  }
  return args
}

function decodeBase64(value, label) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`${label} is not canonical base64`)
  const decoded = Buffer.from(value, "base64")
  if (decoded.toString("base64") !== value) throw new Error(`${label} is not canonical base64`)
  return decoded
}

export function parseTauriPublicKey(encodedPublicKey) {
  const publicKeyFile = decodeBase64(encodedPublicKey, "Tauri updater public key").toString("utf8")
  const lines = publicKeyFile.trimEnd().split(/\r?\n/)
  if (lines.length !== 2 || !lines[0].startsWith("untrusted comment: ")) {
    throw new Error("Tauri updater public key must contain one comment and one key line")
  }

  const packet = decodeBase64(lines[1], "Minisign public key")
  if (packet.length !== 42) throw new Error("Minisign public key packet must be 42 bytes")
  const algorithm = packet.subarray(0, 2).toString("ascii")
  if (algorithm !== "Ed" && algorithm !== "ED") throw new Error(`Unsupported Minisign key algorithm: ${algorithm}`)

  return {
    keyId: packet.subarray(2, 10),
    publicKey: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, packet.subarray(10)]),
      format: "der",
      type: "spki",
    }),
  }
}

export function parseMinisignSignature(contents) {
  const encodedSignature = contents.trimEnd()
  if (encodedSignature.includes("\n") || encodedSignature.includes("\r")) {
    throw new Error("Tauri updater signature must be one canonical base64 line")
  }
  const signatureBox = decodeBase64(encodedSignature, "Tauri updater signature").toString("utf8")
  const lines = signatureBox.trimEnd().split(/\r?\n/)
  if (lines.length !== 4 || !lines[0].startsWith("untrusted comment: ") || !lines[2].startsWith("trusted comment: ")) {
    throw new Error("Minisign signature must contain exactly four canonical lines")
  }

  const packet = decodeBase64(lines[1], "Minisign signature")
  const globalSignature = decodeBase64(lines[3], "Minisign global signature")
  if (packet.length !== 74 || globalSignature.length !== 64) throw new Error("Invalid Minisign signature packet length")
  if (packet.subarray(0, 2).toString("ascii") !== "ED") {
    throw new Error("Legacy non-prehashed Minisign signatures are not accepted")
  }

  const trustedComment = lines[2].slice("trusted comment: ".length)
  const trustedFields = /^timestamp:([0-9]+)\tfile:([^\t\r\n]+)\tversion:([^\t\r\n]+)$/.exec(trustedComment)
  if (!trustedFields || trustedFields[1] === "0") {
    throw new Error("Minisign trusted comment must bind a timestamp, file, and version")
  }

  return {
    keyId: packet.subarray(2, 10),
    signature: packet.subarray(10),
    trustedComment,
    trustedFile: trustedFields[2],
    version: trustedFields[3],
    globalSignature,
  }
}

async function blake2b512(path) {
  const hash = createHash("blake2b512")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest()
}

export async function verifyMinisignFile({
  filePath,
  signaturePath,
  encodedPublicKey,
  expectedVersion,
  expectedTrustedFile,
}) {
  for (const path of [filePath, signaturePath]) {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Minisign input must be a regular file: ${path}`)
  }

  const publicKey = parseTauriPublicKey(encodedPublicKey)
  const signature = parseMinisignSignature(readFileSync(signaturePath, "utf8"))
  if (!publicKey.keyId.equals(signature.keyId)) throw new Error("Minisign signature key id does not match the updater public key")
  if (expectedVersion && signature.version !== expectedVersion) {
    throw new Error(`Minisign trusted version mismatch: expected ${expectedVersion}, got ${signature.version}`)
  }
  if (expectedTrustedFile && signature.trustedFile !== expectedTrustedFile) {
    throw new Error(`Minisign trusted file mismatch: expected ${expectedTrustedFile}, got ${signature.trustedFile}`)
  }

  const digest = await blake2b512(filePath)
  if (!verify(null, digest, publicKey.publicKey, signature.signature)) {
    throw new Error(`Invalid Minisign file signature: ${filePath}`)
  }

  const globalPayload = Buffer.concat([signature.signature, Buffer.from(signature.trustedComment, "utf8")])
  if (!verify(null, globalPayload, publicKey.publicKey, signature.globalSignature)) {
    throw new Error(`Invalid Minisign trusted-comment signature: ${signaturePath}`)
  }
}

export function readUpdaterPublicKey(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"))
  const key = config?.plugins?.updater?.pubkey
  if (typeof key !== "string" || key.length === 0) throw new Error("Tauri updater public key is missing from config")
  return key
}

export async function main(argv = process.argv.slice(2), stdout = process.stdout) {
  const args = parseArgs(argv)
  if (!args.file || !args.signature || !args.config || !args.version || !args["trusted-file"]) {
    throw new Error(
      "Usage: verify-minisign.mjs --file <path> --signature <path> --config <tauri.conf.json> --version <version> --trusted-file <name>",
    )
  }
  await verifyMinisignFile({
    filePath: args.file,
    signaturePath: args.signature,
    encodedPublicKey: readUpdaterPublicKey(args.config),
    expectedVersion: args.version,
    expectedTrustedFile: args["trusted-file"],
  })
  stdout.write(`Verified Minisign signature for ${args.file}\n`)
}

export async function runIfMain(
  metaUrl,
  argvPath = process.argv[1],
  argv = process.argv.slice(2),
  runtime = process,
) {
  if (!argvPath || pathToFileURL(argvPath).href !== metaUrl) return false
  try {
    await main(argv, runtime.stdout)
  } catch (error) {
    runtime.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    runtime.exitCode = 1
  }
  return true
}

void runIfMain(import.meta.url)
