const REF_TERM = ".,;:!?)\\]}\"'\\u2014\\u2019\\u201D\\u2026\\u3001\\u3002\\u3009\\u300B\\u300D\\u300F\\u3011\\u3015\\u3017\\u3019\\u301B\\uFF01\\uFF02\\uFF07\\uFF09\\uFF0C\\uFF0E\\uFF1A\\uFF1B\\uFF1F\\uFF3D\\uFF5D"
const REF_SEG = `[^\\s/#${REF_TERM}]+`
const HANDLE_SEG = `${REF_SEG}#\\d{4,}`

export const CHANNEL_REF_RE = new RegExp(`(?<!/[^\\s${REF_TERM}]*)(?:/${HANDLE_SEG}/${REF_SEG}|/\\.dm/${HANDLE_SEG})(?:#\\d+|/#\\d+(?:#\\d+)?)?(?=\\s|$|[${REF_TERM}])`, "gu")

export const SERVER_REF_RE = new RegExp(`(?<=^|\\s)/${HANDLE_SEG}(?=\\s|$|[${REF_TERM}])`, "gu")

const FENCED_CODE_RE = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]{0,3}\2[ \t]*(?=\n|$)|$)/g
const INLINE_CODE_RE = /(`+)[\s\S]*?\1/g
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()[\]"']+/gi

export function extractChannelRefsFromText(content: string): string[] {
  if (!content.includes("/")) return []
  const stripped = content
    .replace(FENCED_CODE_RE, "\n")
    .replace(INLINE_CODE_RE, " ")
    .replace(URL_RE, " ")
  const matches: string[] = []
  const regex = new RegExp(CHANNEL_REF_RE.source, CHANNEL_REF_RE.flags)
  let match: RegExpExecArray | null
  while ((match = regex.exec(stripped)) !== null) {
    matches.push(match[0])
  }
  return matches
}
