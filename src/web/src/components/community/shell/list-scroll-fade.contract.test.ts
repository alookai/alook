import dmSidebarSource from "../channels/dm-sidebar.tsx?raw"
import channelSidebarSource from "../channels/channel-sidebar.tsx?raw"
import friendsPageSource from "../social/friends-page.tsx?raw"
import friendsSkeletonSource from "../social/friends-page-skeleton.tsx?raw"
import botListViewSource from "../bots/bot-list-view.tsx?raw"
import machineListSource from "../machines/machine-list.tsx?raw"
import botPiiPanelSource from "../bots/bot-pii-panel.tsx?raw"
import serverRailSource from "./server-rail.tsx?raw"
import memberListSource from "../members/member-list.tsx?raw"
import { describe, expect, it } from "vitest"

describe("Community scrollable list edge fade contract", () => {
  it.each([
    ["DM list", dmSidebarSource],
    ["Friends list", friendsPageSource],
    ["Friends skeleton", friendsSkeletonSource],
    ["My Bots list", botListViewSource],
    ["Machines list", machineListSource],
    ["Privacy panel", botPiiPanelSource],
    ["Channel sidebar", channelSidebarSource],
    ["Server rail", serverRailSource],
    ["Member list", memberListSource],
  ])("applies vertical scroll fade to %s", (_label, source) => {
    expect(source).toContain("scroll-fade-y scroll-fade-4")
  })
})
