import { beforeEach, expect, it, vi } from "vitest"
import { render, setupUser } from "@/test/react-dom-harness"
import { TemplateAccountLink } from "./template-account-link"

const state = vi.hoisted(() => ({ session: { data: null as null | { user: { id: string } }, isPending: false }, track: vi.fn() }))
vi.mock("@/lib/auth-client", () => ({ useSession: () => state.session }))
vi.mock("@/lib/analytics", () => ({ trackLandingCtaClicked: state.track }))

beforeEach(() => { state.session = { data: null, isPending: false }; vi.clearAllMocks() })

it.each([false, true])("keeps the public entry available while pending=%s", async isPending => {
  state.session.isPending = isPending
  const view = render(<TemplateAccountLink />)
  const link = view.getByRole("link", { name: "Get Started" })
  expect(link).toHaveAttribute("href", "/sign-in")
  await setupUser().click(link)
  expect(state.track).toHaveBeenCalledWith({ cta_name: "templates_get_started" })
})

it("updates to the account entry after the session resolves", async () => {
  const view = render(<TemplateAccountLink />)
  state.session = { data: { user: { id: "viewer" } }, isPending: false }
  view.rerender(<TemplateAccountLink />)
  const link = view.getByRole("link", { name: "App" })
  expect(link).toHaveAttribute("href", "/c/me")
  await setupUser().click(link)
  expect(state.track).toHaveBeenCalledWith({ cta_name: "templates_open_app" })
})
