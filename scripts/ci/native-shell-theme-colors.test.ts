import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
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
const androidThemeObserver = androidRuntime.match(
  /const val THEME_OBSERVER_SCRIPT = """([\s\S]*?)"""/,
)?.[1]
const iosThemeObserver = iosRuntime
  .match(/static NSString \*const kThemeObserverScript =([\s\S]*?);\n\n@interface/)?.[1]
  .match(/@?"([^"]*)"/g)
  ?.map((literal) => literal.replace(/^@?"/, "").slice(0, -1))
  .join("")

function driveAndroidThemeObserver(initial: Array<"light" | "dark"> = []) {
  const classes = new Set<string>(initial)
  const updates: boolean[] = []
  let notify = () => {}
  const documentElement = {
    classList: { contains: (name: string) => classes.has(name) },
  }
  class MutationObserver {
    constructor(callback: () => void) { notify = callback }
    observe() {}
  }
  runInNewContext(androidThemeObserver ?? "", {
    document: { documentElement },
    MutationObserver,
    window: { AlookNative: { setWindowTheme: (dark: boolean) => updates.push(dark) } },
  })
  return {
    updates,
    apply(theme: "light" | "dark") {
      classes.clear()
      classes.add(theme)
      notify()
    },
  }
}

function driveIosThemeObserver(initial: Array<"light" | "dark"> = []) {
  const classes = new Set<string>(initial)
  const updates: string[] = []
  let notify = () => {}
  const documentElement = {
    classList: { contains: (name: string) => classes.has(name) },
  }
  class MutationObserver {
    constructor(callback: () => void) { notify = callback }
    observe() {}
  }
  runInNewContext(iosThemeObserver ?? "", {
    document: { documentElement },
    MutationObserver,
    window: {
      webkit: {
        messageHandlers: {
          alookTheme: { postMessage: (theme: string) => updates.push(theme) },
        },
      },
    },
  })
  return {
    updates,
    apply(theme: "light" | "dark") {
      classes.clear()
      classes.add(theme)
      notify()
    },
  }
}

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

  it("synchronizes iOS safe-area chrome and status-bar contrast from system and Web themes", () => {
    expect(iosRuntime).toContain("alookEffectiveDarkTheme(self)")
    expect(iosRuntime).toContain("viewController.traitCollection.userInterfaceStyle")
    expect(iosRuntime).toContain("kAlookWebDarkThemeKey")
    expect(iosRuntime).toContain("statusBarNeedsUpdate")
    expect(iosRuntime).toContain("alookApplyTheme(viewController, isDark)")
    expect(iosRuntime).toContain("viewController.view.backgroundColor")
    expect(iosRuntime).toContain("setNeedsStatusBarAppearanceUpdate")
    expect(iosRuntime).toContain("preferredStatusBarStyle")
    expect(iosRuntime).toContain("UIStatusBarStyleLightContent")
    expect(iosRuntime).toContain("UIStatusBarStyleDarkContent")
  })

  it("keeps the restored iOS Web theme authoritative across later layout passes", () => {
    expect(iosRuntime.indexOf("webTheme != nil")).toBeLessThan(
      iosRuntime.indexOf("traitCollection.userInterfaceStyle"),
    )
    expect(iosRuntime).toContain("objc_setAssociatedObject(")
    expect(iosRuntime).toContain("objc_getAssociatedObject(")
    expect(iosRuntime).toContain("bounds.size.height - insets.top - insets.bottom")
    expect(iosRuntime).not.toContain("prefersHomeIndicatorAutoHidden")
  })

  it("leaves the native iOS system theme in place until Web theme resolution", () => {
    const pending = driveIosThemeObserver()
    expect(pending.updates).toEqual([])

    pending.apply("dark")
    pending.apply("light")

    expect(pending.updates).toEqual(["dark", "light"])
    expect(driveIosThemeObserver(["dark"]).updates).toEqual(["dark"])
    expect(driveIosThemeObserver(["light"]).updates).toEqual(["light"])
  })

  it("uses white light chrome and preserves dark chrome at Android launch and runtime", () => {
    expect(androidRuntime).toContain('const val COLOR_LIGHT = "#FFFFFF"')
    expect(androidRuntime).toContain('const val COLOR_DARK = "#100D0A"')
    expect(androidLightSplash).toContain("<item name=\"windowSplashScreenBackground\">#FFFFFF</item>")
    expect(androidDarkSplash).toContain("<item name=\"windowSplashScreenBackground\">#100D0A</item>")
    expect(androidLightSplash).toContain("<item name=\"android:statusBarColor\">#FFFFFF</item>")
    expect(androidLightSplash).toContain("<item name=\"android:navigationBarColor\">#FFFFFF</item>")
    expect(androidLightSplash).toContain("<item name=\"android:windowLightStatusBar\">true</item>")
    expect(androidLightSplash).toContain("<item name=\"android:windowLightNavigationBar\">true</item>")
    expect(androidDarkSplash).toContain("<item name=\"android:statusBarColor\">#100D0A</item>")
    expect(androidDarkSplash).toContain("<item name=\"android:navigationBarColor\">#100D0A</item>")
    expect(androidDarkSplash).toContain("<item name=\"android:windowLightStatusBar\">false</item>")
    expect(androidDarkSplash).toContain("<item name=\"android:windowLightNavigationBar\">false</item>")
  })

  it("synchronizes Android root, system bars, and icon contrast at creation and from the Web bridge", () => {
    expect(androidRuntime).toContain("applyWindowTheme(isDark)")
    expect(androidRuntime.indexOf("applyWindowTheme(isDark)")).toBeLessThan(
      androidRuntime.indexOf("ViewCompat.setOnApplyWindowInsetsListener"),
    )
    expect(androidRuntime).toContain("rootView.setBackgroundColor(color)")
    expect(androidRuntime).toContain("window.statusBarColor = color")
    expect(androidRuntime).toContain("window.navigationBarColor = color")
    expect(androidRuntime).toContain("WindowCompat.getInsetsController(window, rootView)")
    expect(androidRuntime).toContain("isAppearanceLightStatusBars = !dark")
    expect(androidRuntime).toContain("isAppearanceLightNavigationBars = !dark")
    expect(androidRuntime).toContain("activity.applyWindowTheme(dark)")
  })

  it("leaves native DayNight bars in place until Web theme resolution", () => {
    const pending = driveAndroidThemeObserver()
    expect(pending.updates).toEqual([])

    pending.apply("dark")
    pending.apply("light")

    expect(pending.updates).toEqual([true, false])
    expect(driveAndroidThemeObserver(["dark"]).updates).toEqual([true])
    expect(driveAndroidThemeObserver(["light"]).updates).toEqual([false])
  })

  it("keeps Android system-bar and IME inset ownership unchanged", () => {
    expect(androidRuntime).toContain(
      "insets.getInsets(WindowInsetsCompat.Type.systemBars())",
    )
    expect(androidRuntime).toContain(
      "insets.isVisible(WindowInsetsCompat.Type.ime())",
    )
    expect(androidRuntime).toContain(
      "insets.getInsets(WindowInsetsCompat.Type.ime()).bottom",
    )
    expect(androidRuntime).toContain(
      "if (imeVisible) imeHeight else systemBars.bottom",
    )
    expect(androidRuntime).toContain(
      "v.setPadding(systemBars.left, systemBars.top, systemBars.right, bottomPadding)",
    )
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
