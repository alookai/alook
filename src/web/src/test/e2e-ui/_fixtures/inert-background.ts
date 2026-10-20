import { expect, type Locator } from "@playwright/test"

export async function expectInertBackground(target: Locator) {
  await expect(target).toBeVisible()
  await expect.poll(() => target.evaluate(element => {
    const controls = element.matches("a,button,input,textarea,[contenteditable=true]") ? [element]
      : [...element.querySelectorAll("a,button,input,textarea,[contenteditable=true]")]
    return controls.length > 0 && controls.every(control => control.closest("[inert]") && control.closest('[aria-hidden="true"]'))
  })).toBe(true)
}
