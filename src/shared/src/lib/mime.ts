import { nanoid } from "nanoid";

export interface InboundAttachmentMeta {
  key: string;
  filename: string;
  size: number;
  contentType: string;
}

interface ParsedAttachment {
  disposition: string | null;
  filename: string | null;
  mimeType: string;
  content: string | ArrayBuffer | Uint8Array;
}

export function extractAttachmentMeta(attachments: ParsedAttachment[]): InboundAttachmentMeta[] {
  return attachments
    .filter(att => att.disposition === "attachment" || att.filename)
    .map((att, i) => ({
      key: `inline:${i}`,
      filename: att.filename || `attachment-${i}`,
      size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
      contentType: att.mimeType || "application/octet-stream",
    }));
}

export function filterDownloadableAttachments<T extends { disposition: string | null; filename: string | null }>(attachments: T[]): T[] {
  return attachments.filter(att => att.disposition === "attachment" || att.filename);
}

export interface MimeAttachment {
  filename: string;
  contentType: string;
  base64: string;
}

export interface BuildMimeOptions {
  from: string;
  to: string;
  subject: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  date?: string;
  body: string;
  bodyType?: "text/html" | "text/plain";
  attachments?: MimeAttachment[];
}

export function buildMimeMessage(opts: BuildMimeOptions): string {
  const threadingHeaders: string[] = [];
  if (opts.messageId) threadingHeaders.push(`Message-ID: ${opts.messageId}`);
  if (opts.inReplyTo) threadingHeaders.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) threadingHeaders.push(`References: ${opts.references}`);

  const date = opts.date ?? new Date().toUTCString();
  const bodyType = opts.bodyType ?? "text/html";
  const attachments = opts.attachments ?? [];

  if (attachments.length === 0) {
    return [
      `From: ${opts.from}`,
      `To: ${opts.to}`,
      `Subject: ${opts.subject}`,
      `Date: ${date}`,
      ...threadingHeaders,
      `MIME-Version: 1.0`,
      `Content-Type: ${bodyType}; charset=utf-8`,
      "",
      opts.body,
    ].join("\r\n");
  }

  const boundary = `----=_Part_${nanoid(16)}`;
  const parts = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Date: ${date}`,
    ...threadingHeaders,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: ${bodyType}; charset=utf-8`,
    `Content-Transfer-Encoding: 7bit`,
    "",
    opts.body,
  ];

  for (const att of attachments) {
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${att.contentType}; name="${att.filename}"`,
        `Content-Disposition: attachment; filename="${att.filename}"`,
        `Content-Transfer-Encoding: base64`,
        "",
        att.base64.match(/.{1,76}/g)?.join("\r\n") ?? att.base64,
      ].join("\r\n")
    );
  }
  parts.push(`--${boundary}--`);
  return parts.join("\r\n");
}
