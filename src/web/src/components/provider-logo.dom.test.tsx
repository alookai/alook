import { expect, it } from "vitest"
import { render } from "@/test/react-dom-harness"
import { ProviderLogo } from "./provider-logo"
import { runtimeLabel } from "@/lib/community/runtime-label"

it.each([
  ["qoder", "Qoder", "qoder"],
  ["copilot", "GitHub Copilot", "copilot"],
  ["cursor-sdk", "Cursor SDK", "cursor"],
  ["pi-durable", "Pi Durable", "pi"],
])("identifies %s with its name and brand icon", (backend, label, logo) => {
  expect(runtimeLabel(backend)).toBe(label)
  const markup = render(<ProviderLogo provider={backend} />).container.innerHTML
  expect(markup).toContain(`data-provider-logo="${logo}"`)
  expect(markup).not.toContain("lucide-monitor")
})
it("keeps unknown runtime labels intact", () => {
  expect(runtimeLabel("custom-backend")).toBe("custom-backend")
})
