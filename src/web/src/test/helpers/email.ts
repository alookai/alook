import { randomUUID } from "crypto"
import { fetchWithRetry } from "./fetch"

const EMAIL_WORKER_URL = process.env.EMAIL_WORKER_URL ?? "http://localhost:8787"

export function rawEmail(from: string, to: string, subject: string, body: string): string {
  const msgId = `<${randomUUID()}@e2e.test>`
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${msgId}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    body,
  ].join("\r\n")
}

export function rawEmailWithHeaders(
  from: string,
  to: string,
  subject: string,
  body: string,
  headers: Record<string, string>,
): string {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    body,
  ]
  return lines.join("\r\n")
}

export async function postEmail(from: string, to: string, subject: string, body: string): Promise<Response> {
  const url = `${EMAIL_WORKER_URL}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  return fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawEmail(from, to, subject, body),
  })
}

export async function postEmailRaw(from: string, to: string, rawBody: string): Promise<Response> {
  const url = `${EMAIL_WORKER_URL}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  return fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  })
}
