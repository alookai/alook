import type { ReactNode } from "react"
import { Fixtures } from "@/app/brand-visual/app-components"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import { CommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation"

function Viewer({ children }: { children: ReactNode }) {
  return <CurrentUserProvider initialUser={{ id: "demo-gus", email: "gus@example.com", name: "Gus", discriminator: "1813", avatar: "/landing/people/lin.webp" }}><CommunityPreviewNavigation value={true}>{children}</CommunityPreviewNavigation></CurrentUserProvider>
}

export function BusinessFixtures({ children }: { children: ReactNode }) {
  return <Fixtures><Viewer>{children}</Viewer></Fixtures>
}

export function AccountFixtures({ children }: { children: ReactNode }) {
  return <Fixtures accountId="demo-gus"><Viewer>{children}</Viewer></Fixtures>
}
