import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

const ALG = "aes-256-gcm"
const IV_LEN = 12
const TAG_LEN = 16

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest()
}

export function encrypt(plaintext: string, secret: string): string {
  const key = deriveKey(secret)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALG, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString("base64")
}

export function decrypt(encrypted: string, secret: string): string {
  const key = deriveKey(secret)
  const buf = Buffer.from(encrypted, "base64")
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALG, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext) + decipher.final("utf8")
}
