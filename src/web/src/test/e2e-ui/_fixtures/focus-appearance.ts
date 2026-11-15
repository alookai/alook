import { expect, type Locator } from "@playwright/test"

export function readFocusAppearance(control: Locator) {
  return control.evaluate(element => {
    const style = getComputedStyle(element)
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth,
      shadow: style.boxShadow, border: style.borderColor }
  })
}

export async function expectNoFocusOutline(control: Locator) {
  await expect.poll(async () => (await readFocusAppearance(control)).outlineStyle).toBe("none")
}

export async function expectUnchangedFocusDecoration(control: Locator, before: Awaited<ReturnType<typeof readFocusAppearance>>) {
  await expectNoFocusOutline(control)
  await expect.poll(async () => {
    const after = await readFocusAppearance(control)
    return { shadow: after.shadow, border: after.border }
  }).toEqual({ shadow: before.shadow, border: before.border })
}
