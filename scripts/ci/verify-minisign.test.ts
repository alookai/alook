import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { parseMinisignSignature, parseTauriPublicKey, verifyMinisignFile } from "./verify-minisign.mjs"

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
    const lines = Buffer.from(readFileSync(files.signaturePath, "utf8"), "base64").toString("utf8").trimEnd().split("\n")
    const packet = Buffer.from(lines[1], "base64")
    packet[1] = 0x64
    lines[1] = packet.toString("base64")
    expect(() => parseMinisignSignature(Buffer.from(`${lines.join("\n")}\n`).toString("base64"))).toThrow("Legacy")
  })
})
