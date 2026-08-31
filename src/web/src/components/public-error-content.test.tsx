import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.ComponentProps<"a">) => (
    <a data-next-link="true" href={href} {...props}>{children}</a>
  ),
}))
vi.mock("@/components/typewriter-visual", () => ({
  TypewriterVisual: ({ paper }: { paper: React.ReactNode }) => <div>{paper}</div>,
}))

import { ErrorContent } from "./error-content"
import { NotFoundContent } from "./not-found-content"

describe("shared public error presentation", () => {
  it.each([
    ["error", <ErrorContent key="error" reset={() => {}} />, "Something went wrong"],
    ["not found", <NotFoundContent key="not-found" />, "Undeliverable — page not found"],
  ])("keeps the main %s home transition inside Next", (_label, component, copy) => {
    const html = renderToStaticMarkup(component)
    expect(html).toContain(copy)
    expect(html).toContain('data-next-link="true" href="/"')
  })

  it.each([
    ["error", <ErrorContent key="error-hard" reset={() => {}} hardHomeNavigation />],
    ["not found", <NotFoundContent key="not-found-hard" hardHomeNavigation />],
  ])("uses a hard home transition for the Blog %s wrapper", (_label, component) => {
    const html = renderToStaticMarkup(component)
    expect(html).toContain('<a href="/"')
    expect(html).not.toContain("data-next-link")
  })
})
