import { expect, it } from "vitest"
import { render } from "@/test/react-dom-harness"
import { MemberCard } from "./member-card"

it.each([["leader", "Leader"], ["engineer", "Engineer"], ["unknown", "unknown"], ["toString", "toString"], ["constructor", "constructor"], ["__proto__", "__proto__"]])("renders role %s through its own label or raw fallback", (role, label) => {
  const view = render(<MemberCard role={role} description="Role details" />)
  expect(view.getByText(label)).toBeVisible()
  expect(view.getByText("Role details")).toBeVisible()
  expect(view.container.textContent).not.toContain("[object")
})
