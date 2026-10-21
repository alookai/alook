import { IsRestoringProvider } from "@tanstack/react-query"
import { beforeEach, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import { CommunityModuleRouteContext } from "@/contexts/community/module-route"
import { communityKeys } from "@/lib/query-keys"
import FriendsRoute from "../social/friends-route"
import BotsRoute from "../bots/me-bots-route"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: load }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop", useIsMobile: () => false }))
vi.mock("@/lib/community-onboarding", async original => ({ ...await original<typeof import("@/lib/community-onboarding")>(), useCommunityOnboarding: () => null }))
vi.mock("../machines/pair-machine-sheet", () => ({ PairMachineSheet: () => null }))
beforeEach(() => { load.mockReset(); load.mockImplementation(() => new Promise(() => {})) })

it.each(["friends", "bots"] as const)("uses native pending versus cached empty for the real %s consumer during restore", async module => {
  const { client, registry } = await createCommunityQueryOwner()
  const Route = module === "friends" ? FriendsRoute : BotsRoute
  const node = () => <CommunityTestProvider client={client} registry={registry}>
    <CurrentUserProvider initialUser={{ id: "viewer", name: "Viewer", avatar: "V", email: "viewer@example.test" }}>
      <IsRestoringProvider value>
        <CommunityModuleRouteContext value={{ href: `/c/me/${module}`, routeCommitted: false }}><Route /></CommunityModuleRouteContext>
      </IsRestoringProvider>
    </CurrentUserProvider>
  </CommunityTestProvider>
  const view = render(node())
  expect(view.queryByText("No friends yet. Add someone from the New tab.")).toBeNull()
  expect(view.queryByText("No bots yet")).toBeNull()
  expect(view.container.querySelector('[data-slot="skeleton"]')).not.toBeNull()
  expect(load).not.toHaveBeenCalled()
  client.setQueryData(module === "friends" ? communityKeys.friends() : communityKeys.bots(), module === "friends" ? { ids: [] } : { bots: [], observed: false, source: "restored_idb" })
  view.rerender(node())
  expect(view.getByText(module === "friends" ? "No friends yet. Add someone from the New tab." : "No bots yet")).toBeVisible()
  expect(load).not.toHaveBeenCalled()
})
