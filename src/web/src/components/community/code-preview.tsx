"use client"

import { useEffect, useRef, useState, type CSSProperties } from "react"
import { Check, Copy, WrapText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { highlightCode, MAX_CODE_HIGHLIGHT_LINES, type CodeHighlightResult, type CodeToken } from "@/lib/community/code-highlight"
import type { ShikiLanguage } from "@/lib/community/attachment-presentation"
import { tid } from "@/lib/community/testids"

const LANGUAGE_LABELS: Record<ShikiLanguage, string> = {
  bash: "Shell",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  diff: "Diff",
  dockerfile: "Dockerfile",
  dotenv: "Environment",
  go: "Go",
  graphql: "GraphQL",
  hcl: "HCL",
  html: "HTML source",
  ini: "Config",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  jsonl: "JSON Lines",
  jsx: "JSX",
  kotlin: "Kotlin",
  log: "Log",
  makefile: "Makefile",
  mdx: "MDX source",
  php: "PHP",
  proto: "Protocol Buffers",
  python: "Python",
  ruby: "Ruby",
  rust: "Rust",
  scss: "SCSS",
  sql: "SQL",
  svelte: "Svelte",
  swift: "Swift",
  toml: "TOML",
  tsx: "TSX",
  typescript: "TypeScript",
  vue: "Vue",
  xml: "XML source",
  yaml: "YAML",
}

type TokenStyle = CSSProperties & {
  "--code-token-light"?: string
  "--code-token-dark"?: string
}

function tokenStyle(token: CodeToken): TokenStyle {
  const fontStyle = token.light.fontStyle ?? token.dark.fontStyle ?? 0
  const decorations = [
    fontStyle & 4 ? "underline" : "",
    fontStyle & 8 ? "line-through" : "",
  ].filter(Boolean).join(" ")
  return {
    "--code-token-light": token.light.color,
    "--code-token-dark": token.dark.color,
    fontStyle: fontStyle & 1 ? "italic" : undefined,
    fontWeight: fontStyle & 2 ? 600 : undefined,
    textDecoration: decorations || undefined,
  }
}

function sourceLines(content: string): string[] {
  return content.split("\n")
}

function lineNumbers(count: number): string {
  return Array.from({ length: count }, (_, index) => String(index + 1)).join("\n")
}

export function CodePreview({
  content,
  language,
}: {
  content: string
  language: ShikiLanguage | null
}) {
  const [highlight, setHighlight] = useState<CodeHighlightResult>({ kind: "plain", lines: null, reason: null })
  const [highlighting, setHighlighting] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let active = true
    setHighlight({ kind: "plain", lines: null, reason: null })
    setHighlighting(language !== null)
    setCopyState("idle")
    if (copyTimer.current) clearTimeout(copyTimer.current)
    void highlightCode(content, language).then((result) => {
      if (!active) return
      setHighlight(result)
      setHighlighting(false)
    })
    return () => {
      active = false
    }
  }, [content, language])

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
  }, [])

  async function copyContent(): Promise<void> {
    try {
      await navigator.clipboard.writeText(content)
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopyState("idle"), 2_000)
  }

  const fallbackLines = sourceLines(content)
  const lines = highlight.kind === "highlighted" ? highlight.lines : fallbackLines
  const useCompactPlainText = highlight.kind === "plain" && fallbackLines.length > MAX_CODE_HIGHLIGHT_LINES
  const label = language ? LANGUAGE_LABELS[language] : "Plain text"
  const status = highlighting ? "Highlighting…" : highlight.reason

  return (
    <section
      data-testid={tid.codePreview}
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-muted/20"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-2 py-1">
        <span data-testid={tid.codePreviewLanguage} className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {label}
        </span>
        {status && (
          <span data-testid={tid.codePreviewStatus} role="status" className="truncate text-xs text-muted-foreground">
            {status}
          </span>
        )}
        <Button
          data-testid={tid.codePreviewWrap}
          type="button"
          variant={wrap ? "secondary" : "ghost"}
          size="sm"
          className="h-11 sm:h-7"
          aria-pressed={wrap}
          onClick={() => setWrap((value) => !value)}
        >
          <WrapText className="size-3.5" />
          Wrap
        </Button>
        <Button
          data-testid={tid.codePreviewCopy}
          type="button"
          variant="ghost"
          size="sm"
          className="h-11 sm:h-7"
          onClick={() => void copyContent()}
          aria-label={copyState === "failed" ? "Copy failed" : copyState === "copied" ? "Copied" : "Copy source"}
        >
          {copyState === "copied" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copyState === "copied" ? "Copied" : copyState === "failed" ? "Retry copy" : "Copy"}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto thin-scrollbar font-mono text-[13px] leading-6">
        {useCompactPlainText ? (
          <div className={cn("grid min-h-full grid-cols-[auto_minmax(0,1fr)] py-3", !wrap && "w-max min-w-full")}>
            <pre
              aria-hidden="true"
              className="select-none border-r border-border/60 px-3 text-right text-muted-foreground/60"
            >
              {lineNumbers(fallbackLines.length)}
            </pre>
            <pre
              className={cn(
                "min-w-0 px-4 text-foreground",
                wrap ? "whitespace-pre-wrap wrap-break-word" : "whitespace-pre",
              )}
            >
              {content}
            </pre>
          </div>
        ) : (
          <div className={cn("min-w-max py-3", wrap && "min-w-0")}>
            {lines.map((line, index) => (
              <div key={index} className="grid min-h-6 grid-cols-[3.5rem_minmax(0,1fr)]">
                <span aria-hidden="true" className="select-none border-r border-border/60 pr-3 text-right text-muted-foreground/60">
                  {index + 1}
                </span>
                <code className={cn("block min-w-0 px-4", wrap ? "whitespace-pre-wrap wrap-break-word" : "whitespace-pre")}>
                  {highlight.kind === "highlighted"
                    ? (line as CodeToken[]).map((token, tokenIndex) => (
                        <span
                          key={tokenIndex}
                          style={tokenStyle(token)}
                          className="text-(--code-token-light) dark:text-(--code-token-dark)"
                        >
                          {token.content}
                        </span>
                      ))
                    : (line as string) || "\u200b"}
                </code>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
