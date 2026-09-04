import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "onboarding-select-dialog.tsx"),
  "utf8",
)

describe("OnboardingSelectDialog contract", () => {
  it("builds on the shared shadcn dialog, field, and radio primitives", () => {
    expect(source).toContain('from "@/components/ui/dialog"')
    expect(source).toContain('from "@/components/ui/field"')
    expect(source).toContain('from "@/components/ui/radio-group"')
    expect(source).toContain('from "@/components/provider-logo"')
  })

  it("keeps odd choices left aligned", () => {
    expect(source).not.toContain("sm:col-start-4")
    expect(source).toContain('className="grid grid-cols-1 gap-2 sm:grid-cols-2"')
  })

  it("keeps selection controlled", () => {
    expect(source).toContain("value: string")
    expect(source).toContain("onValueChange: (value: string) => void")
  })

  it("renders an optional custom identity as a separate always-visible field", () => {
    expect(source).toContain("customOption?:")
    expect(source).toContain("customValue.trim()")
    expect(source).toContain("onCustomValueChange")
    expect(source).toContain("changeOnboardingCustomValue(")
    expect(source).not.toContain("onFocus={() => onValueChange(customOption.value)}")
    expect(source).toContain("<Input")
    expect(source).not.toContain("<PencilLineIcon")
  })

  it("includes visible async, error, success, disabled, focus, and mobile touch states", () => {
    expect(source).toContain('"loading"')
    expect(source).toContain('"error"')
    expect(source).toContain('"success"')
    expect(source).toContain("focus-visible")
    expect(source).toContain("disabled")
    expect(source).toContain("h-11")
    expect(source).toContain('aria-live="polite"')
  })
})
