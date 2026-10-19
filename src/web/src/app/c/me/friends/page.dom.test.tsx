import React from "react"
import { renderToString } from "react-dom/server"
import { render } from "@/test/react-dom-harness"
import { beforeEach, describe, expect, it, vi } from "vitest"
import MeFriendsPage from "./page"

const mocks = vi.hoisted(() => ({ breakpoint: "unknown", props: vi.fn(), back: vi.fn() }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mocks.breakpoint }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock("@/hooks/community/use-friends", () => ({ useFriends: () => ({ friends: [], pending: [], blocked: [], isLoading: true }) }))
vi.mock("@/stores/community", () => ({ useUiHandlers: () => ({ goBackMobile: mocks.back }) }))
vi.mock("@/lib/community-db/projections", () => ({ useCanonicalProfilesByUserId: () => new Map() }))
vi.mock("@/hooks/community/mutations", () => {
  const mutation = () => ({ mutateAsync: vi.fn(), mutate: vi.fn() })
  return { useSendFriendRequest: mutation, useAcceptFriendRequest: mutation, useRejectFriendRequest: mutation,
    useCancelBotFriendRequest: mutation, useRemoveFriend: mutation, useBlockUser: mutation,
    useUnblockUser: mutation, useCreateOrGetDm: mutation }
})
vi.mock("@/components/community/social/friends-page", () => ({ FriendsPage: (props: Record<string, unknown>) => { mocks.props(props); return null } }))

beforeEach(() => { mocks.props.mockClear(); mocks.back.mockClear() })

describe("friends route initial mobile back ownership", () => {
  it.each(["unknown", "mobile", "desktop"])("supplies the same viewport-owned Back action at %s", (breakpoint) => {
    mocks.breakpoint = breakpoint
    renderToString(<MeFriendsPage />)
    const props = mocks.props.mock.calls.at(-1)![0] as { onBack?: () => void }
    expect(props.onBack).toBeTypeOf("function")
    const view = render(<MeFriendsPage />)
    const clientProps = mocks.props.mock.calls.at(-1)![0] as { onBack?: () => void }
    expect(clientProps.onBack).toBeTypeOf("function")
    props.onBack!()
    clientProps.onBack!()
    expect(mocks.back).toHaveBeenCalledTimes(2)
    view.unmount()
  })
})
