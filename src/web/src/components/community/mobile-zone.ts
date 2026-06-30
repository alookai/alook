import type { MobileZone } from "./_types"

export type MobileZoneAction =
  | { type: "setActiveChannel" }
  | { type: "enterDm" }
  | { type: "onShowFriends" }
  | { type: "onShowMachines" }
  | { type: "goBackMobile" }
  | { type: "goHome" }
  | { type: "goServer" }

export function initialMobileZone(hasChannel: boolean): MobileZone {
  return hasChannel ? "messages" : "nav"
}

export function nextMobileZone(_state: MobileZone, action: MobileZoneAction): MobileZone {
  switch (action.type) {
    case "setActiveChannel":
    case "enterDm":
    case "onShowFriends":
    case "onShowMachines":
      return "messages"
    case "goBackMobile":
    case "goHome":
    case "goServer":
      return "nav"
  }
}
