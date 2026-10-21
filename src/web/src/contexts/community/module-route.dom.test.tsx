import { expect, it, vi } from "vitest"
import { fireEvent, render } from "@/test/react-dom-harness"
import { CommunityRouteContext } from "./route-frame"
import { CommunityModuleRouteContext, useCommunityModuleLocation, useCommunityRouter } from "./module-route"

const next = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => next, useSearchParams: () => new URLSearchParams("published=old") }))
function Entry() {
  const router = useCommunityRouter()
  const location = useCommunityModuleLocation()
  return <><button onClick={() => router.push("/c/channels/target/thread?msg=opener")}>Open target</button>
    <button onClick={() => location.router.replace("/c/me/friends?tab=new")}>Select tab</button>
    <span>{location.searchParams.toString()}</span></>
}
it.each([false, true])("uses the existing intent owner for all module and nested entry callbacks (committed=%s)", routeCommitted => {
  const navigation = { push: vi.fn(), replace: vi.fn() }
  const view = render(<CommunityRouteContext value={{ navigation } as never}>
    <CommunityModuleRouteContext value={{ href: "/c/me/bots?audit=target", routeCommitted }}><Entry /></CommunityModuleRouteContext>
  </CommunityRouteContext>)
  fireEvent.click(view.getByRole("button", { name: "Open target" }))
  fireEvent.click(view.getByRole("button", { name: "Select tab" }))
  expect(navigation.push).toHaveBeenCalledExactlyOnceWith("/c/channels/target/thread?msg=opener")
  expect(navigation.replace).toHaveBeenCalledExactlyOnceWith("/c/me/friends?tab=new")
  expect(next.push).not.toHaveBeenCalled()
  expect(next.replace).not.toHaveBeenCalled()
  expect(view.getByText("audit=target")).toBeVisible()
})
it("keeps the native router at a providerless public or isolated page boundary", () => {
  next.push.mockClear(); next.replace.mockClear()
  const view = render(<Entry />)
  fireEvent.click(view.getByRole("button", { name: "Open target" }))
  expect(next.push).toHaveBeenCalledExactlyOnceWith("/c/channels/target/thread?msg=opener")
  expect(view.getByText("published=old")).toBeVisible()
})
