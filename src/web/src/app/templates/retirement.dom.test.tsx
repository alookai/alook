import { expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { TEMPLATES } from "@/lib/templates"
import { TemplateCard } from "./_components/template-card"
import { TemplateDetailClient } from "./[id]/client"

vi.mock("@/components/public-layout", () => ({ PublicLayout: ({ children, rightSlot }: { children: React.ReactNode; rightSlot: React.ReactNode }) => <main>{rightSlot}{children}</main> }))
vi.mock("next/link", () => ({ default: ({ children, href, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a> }))

it("keeps public template content and canonical detail navigation", () => {
  const template = TEMPLATES[0]!
  const view = render(<TemplateCard template={template} />)
  expect(view.getByRole("heading")).toHaveTextContent(template.name)
  expect(view.getByRole("link")).toHaveAttribute("href", `/templates/${template.id}`)
  expect(view.queryByRole("button", { name: "Use" })).toBeNull()
})
it.each([true, false])("retains readable details and public entry links for logged-in=%s without a Studio CTA", isLoggedIn => {
  const template = TEMPLATES[0]!
  const view = render(<TemplateDetailClient template={template} isLoggedIn={isLoggedIn} />)
  expect(view.getByRole("heading", { name: template.name })).toBeVisible()
  expect(view.getByText(template.longDescription)).toBeVisible()
  expect(view.getAllByRole("link").map(link => link.getAttribute("href"))).not.toEqual(expect.arrayContaining([expect.stringContaining("/studio/new")]))
  expect(view.queryByRole("link", { name: "Use This Template" })).toBeNull()
})
