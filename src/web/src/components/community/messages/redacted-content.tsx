import type { ReactNode } from "react"
import type { Element, ElementContent, Root } from "hast"
import type { Plugin } from "unified"
import { CodeBlockContainer, CodeBlockCopyButton, CodeBlockHeader } from "streamdown"

const REDACTED = /\[REDACTED(?:_[A-Z0-9]+)*\]/g

export function RedactedBadge({ children }: { children?: ReactNode }) {
  return <span data-redacted role="img" aria-label="redacted" className="inline-block whitespace-nowrap rounded-sm bg-muted px-1 align-baseline font-sans text-xs font-medium leading-normal text-muted-foreground after:content-['redacted']"><span aria-hidden className="sr-only">{children}</span></span>
}

function parts(text: string): string[] {
  return text.split(new RegExp(`(${REDACTED.source})`, "g"))
}

function codeText(node: Element | ElementContent): string {
  return node.type === "text" ? node.value : "children" in node ? node.children.map(codeText).join("") : ""
}

export const redactedContentPlugin: Plugin<[], Root> = () => (tree) => {
  function visit(parent: Root | Element) {
    const merged: Root["children"] = []
    for (const node of parent.children) {
      const previous = merged.at(-1)
      if (node.type === "text" && previous?.type === "text") previous.value += node.value
      else merged.push(node)
    }
    parent.children = merged.flatMap((node): ElementContent[] => {
      if (node.type === "text") {
        return parts(node.value).map((value, index) => index % 2 ? {
          type: "element", tagName: "redacted", properties: {}, children: [{ type: "text", value }],
        } : { type: "text", value })
      }
      if (node.type === "element") {
        const classes = node.properties.className as string[] | undefined
        if (["math", "annotation", "redacted", "redactedcode"].includes(node.tagName)) return [node]
        if (node.tagName === "code" && classes?.some((name) => name === "language-mermaid" || name === "math-inline" || name === "math-display")) {
          if (!classes.includes("language-mermaid")) {
            node.children = [{ type: "text", value: codeText(node).replace(REDACTED, (value) => `\\text{${value.replaceAll("_", "\\_")}}`) }]
          }
          return [node]
        }
        if (node.tagName === "code" && parts(codeText(node)).length > 1) {
          const language = (node.properties.className as string[] | undefined)?.find((name) => name.startsWith("language-"))?.slice(9) ?? ""
          node.tagName = "redactedcode"
          node.properties = { dataRedactedBlock: parent.type === "element" && parent.tagName === "pre" ? "1" : "0", dataLanguage: language }
        } else {
          visit(node)
        }
        return [node]
      }
      return node.type === "comment" ? [node] : []
    })
  }
  visit(tree)
}

export function RedactedCode({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) {
  const text = String(children ?? "")
  const content = parts(text).map((value, index) => index % 2 ? <RedactedBadge key={index}>{value}</RedactedBadge> : value)
  if (props["data-redacted-block"] !== "1") {
    return <code data-streamdown="inline-code" className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">{content}</code>
  }
  const language = String(props["data-language"] ?? "")
  return (
    <CodeBlockContainer language={language}>
      <CodeBlockHeader language={language} />
      <div className="pointer-events-none absolute right-2 top-2 z-10 flex items-center">
        <div data-streamdown="code-block-actions" className="pointer-events-auto flex items-center gap-2">
          <CodeBlockCopyButton code={text} />
        </div>
      </div>
      <div data-streamdown="code-block-body" className="thin-scrollbar overflow-x-auto overflow-y-auto">
        <pre><code>{content}</code></pre>
      </div>
    </CodeBlockContainer>
  )
}
