import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repositoryRoot = resolve(import.meta.dirname, "../..")
const desktopRoot = resolve(repositoryRoot, "src/desktop/src-tauri")

const macosRuntime = readFileSync(resolve(desktopRoot, "src/commands.rs"), "utf8")
const iosRuntime = readFileSync(resolve(desktopRoot, "gen/apple/Sources/alook-desktop/main.mm"), "utf8")
const iosSplash = JSON.parse(
  readFileSync(
    resolve(desktopRoot, "gen/apple/Assets.xcassets/SplashBackground.colorset/Contents.json"),
    "utf8",
  ),
) as {
  colors: Array<{
    appearances?: Array<{ appearance: string; value: string }>
    color: { components: Record<string, string> }
  }>
}
const androidRuntime = readFileSync(
  resolve(desktopRoot, "gen/android/app/src/main/java/ai/alook/android/MainActivity.kt"),
  "utf8",
)
const androidLightSplash = readFileSync(
  resolve(desktopRoot, "gen/android/app/src/main/res/values/themes.xml"),
  "utf8",
)
const androidDarkSplash = readFileSync(
  resolve(desktopRoot, "gen/android/app/src/main/res/values-night/themes.xml"),
  "utf8",
)

describe("native shell theme color contract", () => {
  it("uses white light chrome and preserves dark chrome on macOS", () => {
    expect(macosRuntime).toContain("(0.063f64, 0.051f64, 0.039f64)")
    expect(macosRuntime).toContain("(1.0f64, 1.0f64, 1.0f64)")
    expect(macosRuntime).toContain("setBackgroundColor: color")
  })

  it("uses white light chrome and preserves dark chrome at iOS launch and runtime", () => {
    expect(iosRuntime).toContain("colorWithRed:1.0 green:1.0 blue:1.0 alpha:1.0")
    expect(iosRuntime).toContain("colorWithRed:0.063 green:0.051 blue:0.039 alpha:1.0")

    const light = iosSplash.colors.find((entry) => !entry.appearances)
    const dark = iosSplash.colors.find((entry) =>
      entry.appearances?.some(({ appearance, value }) => appearance === "luminosity" && value === "dark"),
    )
    expect(light?.color.components).toMatchObject({ red: "1.000", green: "1.000", blue: "1.000" })
    expect(dark?.color.components).toMatchObject({ red: "0.063", green: "0.051", blue: "0.039" })
  })

  it("uses white light chrome and preserves dark chrome at Android launch and runtime", () => {
    expect(androidRuntime).toContain('const val COLOR_LIGHT = "#FFFFFF"')
    expect(androidRuntime).toContain('const val COLOR_DARK = "#100D0A"')
    expect(androidLightSplash).toContain("<item name=\"windowSplashScreenBackground\">#FFFFFF</item>")
    expect(androidDarkSplash).toContain("<item name=\"windowSplashScreenBackground\">#100D0A</item>")
  })

  it("retains runtime theme bridges and removes the legacy light color from native owners", () => {
    expect(iosRuntime).toContain("new MutationObserver(sync)")
    expect(iosRuntime).toContain('addScriptMessageHandler:handler name:@"alookTheme"')
    expect(androidRuntime).toContain("WebViewCompat.addDocumentStartJavaScript")
    expect(androidRuntime).toContain('webView.addJavascriptInterface(ThemeBridge(this), "AlookNative")')

    const nativeOwners = [macosRuntime, iosRuntime, JSON.stringify(iosSplash), androidRuntime, androidLightSplash]
    for (const source of nativeOwners) {
      expect(source).not.toMatch(/#ECE8DE|0\.929[^\n]+0\.910[^\n]+0\.871/)
    }
  })
})
