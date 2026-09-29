import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import {
  main as runMinisignCli,
  parseArgs as parseMinisignArgs,
  parseMinisignSignature,
  parseTauriPublicKey,
  readUpdaterPublicKey,
  runIfMain as runMinisignIfMain,
  verifyMinisignFile,
} from "./verify-minisign.mjs"

const temporaryDirectories: string[] = []

function fixture(data: Buffer) {
  const directory = mkdtempSync(join(tmpdir(), "alook-minisign-"))
  temporaryDirectories.push(directory)
  const filePath = join(directory, "artifact.bin")
  const signaturePath = `${filePath}.sig`
  writeFileSync(filePath, data)

  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const publicDer = publicKey.export({ format: "der", type: "spki" })
  const keyId = randomBytes(8)
  const publicPacket = Buffer.concat([Buffer.from("ED"), keyId, publicDer.subarray(-32)])
  const publicFile = `untrusted comment: fixture key\n${publicPacket.toString("base64")}\n`
  const encodedPublicKey = Buffer.from(publicFile).toString("base64")

  const digest = createHash("blake2b512").update(data).digest()
  const fileSignature = sign(null, digest, privateKey)
  const trustedComment = "timestamp:1\tfile:artifact.bin\tversion:1.2.3"
  const globalSignature = sign(null, Buffer.concat([fileSignature, Buffer.from(trustedComment)]), privateKey)
  const signaturePacket = Buffer.concat([Buffer.from("ED"), keyId, fileSignature])
  const signatureBox = `untrusted comment: fixture signature\n${signaturePacket.toString("base64")}\ntrusted comment: ${trustedComment}\n${globalSignature.toString("base64")}\n`
  writeFileSync(signaturePath, Buffer.from(signatureBox).toString("base64"))

  return { directory, encodedPublicKey, filePath, signaturePath }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

describe("verifyMinisignFile", () => {
  it("verifies the prehashed file signature and trusted comment", async () => {
    const files = fixture(Buffer.from("exact release bytes"))
    await expect(
      verifyMinisignFile({ ...files, expectedVersion: "1.2.3", expectedTrustedFile: "artifact.bin" }),
    ).resolves.toBeUndefined()
  })

  it("rejects mutated artifact bytes", async () => {
    const files = fixture(Buffer.from("exact release bytes"))
    writeFileSync(files.filePath, "mutated release bytes")
    await expect(
      verifyMinisignFile({ ...files, expectedVersion: "1.2.3", expectedTrustedFile: "artifact.bin" }),
    ).rejects.toThrow("Invalid Minisign file signature")
  })

  it("rejects a forged trusted comment", async () => {
    const files = fixture(Buffer.from("exact release bytes"))
    const signature = Buffer.from(readFileSync(files.signaturePath, "utf8"), "base64")
      .toString("utf8")
      .replace("timestamp:1", "timestamp:2")
    writeFileSync(files.signaturePath, Buffer.from(signature).toString("base64"))
    await expect(
      verifyMinisignFile({ ...files, expectedVersion: "1.2.3", expectedTrustedFile: "artifact.bin" }),
    ).rejects.toThrow("trusted-comment")
  })

  it("rejects trusted version and filename drift", async () => {
    const files = fixture(Buffer.from("exact release bytes"))
    await expect(
      verifyMinisignFile({ ...files, expectedVersion: "9.9.9", expectedTrustedFile: "artifact.bin" }),
    ).rejects.toThrow("trusted version mismatch")
    await expect(
      verifyMinisignFile({ ...files, expectedVersion: "1.2.3", expectedTrustedFile: "renamed.bin" }),
    ).rejects.toThrow("trusted file mismatch")
  })

  it("rejects malformed and legacy packets", () => {
    const files = fixture(Buffer.from("exact release bytes"))
    expect(() => parseTauriPublicKey(`${files.encodedPublicKey}=`)).toThrow("canonical base64")

    const malformedPublicFile = Buffer.from("not a Minisign key\n").toString("base64")
    expect(() => parseTauriPublicKey(malformedPublicFile)).toThrow("one comment and one key line")

    const shortPublicPacket = Buffer.alloc(41).toString("base64")
    expect(() => parseTauriPublicKey(Buffer.from(`untrusted comment: short\n${shortPublicPacket}\n`).toString("base64"))).toThrow("42 bytes")

    const unsupportedPublicPacket = Buffer.concat([Buffer.from("XX"), Buffer.alloc(40)]).toString("base64")
    expect(() => parseTauriPublicKey(Buffer.from(`untrusted comment: unsupported\n${unsupportedPublicPacket}\n`).toString("base64"))).toThrow("Unsupported Minisign key algorithm")

    expect(() => parseMinisignSignature("YQ==\nYg==")).toThrow("one canonical base64 line")
    expect(() => parseMinisignSignature(Buffer.from("not four lines\n").toString("base64"))).toThrow("exactly four canonical lines")

    const lines = Buffer.from(readFileSync(files.signaturePath, "utf8"), "base64").toString("utf8").trimEnd().split("\n")
    const shortPacket = [...lines]
    shortPacket[1] = Buffer.alloc(10).toString("base64")
    expect(() => parseMinisignSignature(Buffer.from(`${shortPacket.join("\n")}\n`).toString("base64"))).toThrow("packet length")

    const missingTrustedBinding = [...lines]
    missingTrustedBinding[2] = missingTrustedBinding[2].replace("timestamp:1", "timestamp:0")
    expect(() => parseMinisignSignature(Buffer.from(`${missingTrustedBinding.join("\n")}\n`).toString("base64"))).toThrow("must bind")

    const packet = Buffer.from(lines[1], "base64")
    packet[1] = 0x64
    lines[1] = packet.toString("base64")
    expect(() => parseMinisignSignature(Buffer.from(`${lines.join("\n")}\n`).toString("base64"))).toThrow("Legacy")
  })

  it("rejects noncanonical base64, non-files, mismatched keys, and missing config keys", async () => {
    const files = fixture(Buffer.from("exact release bytes"))
    expect(() => parseTauriPublicKey("ZE==")).toThrow("canonical base64")

    const directoryInput = join(files.directory, "directory-input")
    mkdirSync(directoryInput)
    await expect(verifyMinisignFile({
      ...files,
      filePath: directoryInput,
      expectedVersion: "1.2.3",
      expectedTrustedFile: "artifact.bin",
    })).rejects.toThrow("regular file")

    const signatureLines = Buffer.from(readFileSync(files.signaturePath, "utf8"), "base64").toString("utf8").trimEnd().split("\n")
    const signaturePacket = Buffer.from(signatureLines[1], "base64")
    signaturePacket[2] ^= 0xff
    signatureLines[1] = signaturePacket.toString("base64")
    writeFileSync(files.signaturePath, Buffer.from(`${signatureLines.join("\n")}\n`).toString("base64"))
    await expect(verifyMinisignFile({
      ...files,
      expectedVersion: "1.2.3",
      expectedTrustedFile: "artifact.bin",
    })).rejects.toThrow("key id does not match")

    const configPath = join(files.directory, "tauri.conf.json")
    writeFileSync(configPath, JSON.stringify({ plugins: { updater: {} } }))
    expect(() => readUpdaterPublicKey(configPath)).toThrow("public key is missing")
  })

  it("covers CLI parsing, success output, usage errors, and entrypoint failures", async () => {
    expect(parseMinisignArgs(["--file", "artifact", "--signature", "signature"])).toEqual({
      file: "artifact",
      signature: "signature",
    })
    expect(() => parseMinisignArgs(["file", "artifact"])).toThrow("Invalid argument")

    await expect(runMinisignCli([])).rejects.toThrow("Usage")

    const files = fixture(Buffer.from("exact release bytes"))
    const configPath = join(files.directory, "tauri.conf.json")
    writeFileSync(configPath, JSON.stringify({ plugins: { updater: { pubkey: files.encodedPublicKey } } }))
    const stdout: string[] = []
    await expect(runMinisignCli([
      "--file", files.filePath,
      "--signature", files.signaturePath,
      "--config", configPath,
      "--version", "1.2.3",
      "--trusted-file", "artifact.bin",
    ], { write: (value: string) => stdout.push(value) })).resolves.toBeUndefined()
    expect(stdout.join("")).toContain("Verified Minisign signature")

    const entryPath = join(files.directory, "verify-minisign.mjs")
    const stderr: string[] = []
    const runtime = {
      stdout: { write: (value: string) => stdout.push(value) },
      stderr: { write: (value: string) => stderr.push(value) },
      exitCode: 0,
    }
    await expect(runMinisignIfMain(pathToFileURL(entryPath).href, join(files.directory, "other.mjs"), [], runtime)).resolves.toBe(false)
    await expect(runMinisignIfMain(pathToFileURL(entryPath).href, entryPath, [], runtime)).resolves.toBe(true)
    expect(stderr.join("")).toContain("Usage")
    expect(runtime.exitCode).toBe(1)
  })
})
