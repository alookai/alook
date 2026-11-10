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
    document: { documentElement, body: {}, querySelector: () => null, addEventListener() {}, createElement: () => ({ getContext: () => ({ fillRect() {}, getImageData: () => ({ data: [0, 0, 0, 0] }) }) }) },
    getComputedStyle: () => ({ backgroundColor: "transparent" }),
    MutationObserver,
    window: { addEventListener() {}, AlookNative: { setWindowTheme: (dark: boolean) => updates.push(dark) } },
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
    document: { documentElement, body: {}, querySelector: () => null, addEventListener() {}, createElement: () => ({ getContext: () => ({ fillRect() {}, getImageData: () => ({ data: [0, 0, 0, 0] }) }) }) },
    getComputedStyle: () => ({ backgroundColor: "transparent" }),
    MutationObserver,
    window: {
      addEventListener() {},
      webkit: {
        messageHandlers: {
          alookTheme: { postMessage: (payload: { theme: string }) => updates.push(payload.theme) },
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
  it.each(["ios", "android"])("%s reports the painted surface after load and navigation", (platform) => {
    const updates: Array<{ theme: string; background: string | null }> = []
    const listeners = new Map<string, () => void>()
    let publishedColor: string | null = null
    let drawnColor = ""
    const colors: Record<string, number[]> = {
      body: [224, 213, 192, 255],
      list: [250, 246, 238, 255],
      chat: [255, 253, 248, 255],
      darkChat: [0, 0, 0, 255],
      darkList: [13, 13, 13, 255],
      transparent: [0, 0, 0, 0],
    }
    let dark = false
    const documentElement = { classList: { contains: (name: string) => name === (dark ? "dark" : "light") } }
    const context = {
      document: {
        documentElement, body: {}, querySelector: () => publishedColor === null ? null : { content: publishedColor }, addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
        createElement: () => ({ getContext: () => ({
          set fillStyle(value: string) { drawnColor = value },
          fillRect() {}, getImageData: () => ({ data: colors[drawnColor] }),
        }) }),
      },
      getComputedStyle: () => ({ backgroundColor: "body" }),
      MutationObserver: class { observe() {} },
      window: {
        addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
        webkit: { messageHandlers: { alookTheme: { postMessage: (payload: typeof updates[number]) => updates.push(payload) } } },
        AlookNative: {
          setWindowBackground: (isDark: boolean, background: string) => updates.push({ theme: isDark ? "dark" : "light", background }),
          setWindowTheme: (isDark: boolean) => updates.push({ theme: isDark ? "dark" : "light", background: null }),
        },
      },
    }
    runInNewContext((platform === "ios" ? iosThemeObserver : androidThemeObserver) ?? "", context)
    expect(updates.at(-1)).toEqual({ theme: "light", background: "#e0d5c0" })
    for (const [color, expected] of [["list", "#faf6ee"], ["chat", "#fffdf8"], ["list", "#faf6ee"]]) {
      publishedColor = color
      listeners.get("alook:theme-color-change")!()
      expect(updates.at(-1)).toEqual({ theme: "light", background: expected })
    }
    dark = true
    publishedColor = "darkChat"
    listeners.get("load")!()
    expect(updates.at(-1)).toEqual({ theme: "dark", background: "#000000" })
    publishedColor = "darkList"
    listeners.get("alook:theme-color-change")!()
    expect(updates.at(-1)).toEqual({ theme: "dark", background: "#0d0d0d" })
    publishedColor = "transparent"
    listeners.get("alook:theme-color-change")!()
    expect(updates.at(-1)).toEqual({ theme: "dark", background: null })
  })
  it("separates full native framing from the current root's keyboard overlap", () => {
    const layout = iosRuntime.split("- (void)alook_viewDidLayoutSubviews {")[1]?.split("\n}\n")[0] ?? ""
    const install = iosRuntime.split("static void alookInstallKeyboardLayout(")[1]?.split("\n}\n")[0] ?? ""
    expect(layout.indexOf("alookInstallKeyboardLayout(self)")).toBeGreaterThanOrEqual(0)
    expect(layout.indexOf("alookInstallKeyboardLayout(self)")).toBeLessThan(layout.indexOf("alookPublishKeyboardSnapshots(self, NO)"))
    expect(install).toContain("previous.superview == host")
    expect(install).toContain("removeFromSuperview")
    expect(install).toContain("host.keyboardLayoutGuide.topAnchor")
    expect(install).toContain("translatesAutoresizingMaskIntoConstraints = NO")
    expect(layout).not.toContain("contentFrame = guide.layoutFrame")
    expect(layout).toContain("webView.frame = contentFrame")
    expect(layout.indexOf("webView.frame = contentFrame")).toBeLessThan(layout.indexOf("alookPublishKeyboardSnapshots(self, NO)"))
  })

  it("measures snapshot requests live and publishes after the guide-constrained native view lays out", () => {
    const measure = iosRuntime.split("static NSDictionary *alookMeasureKeyboardSnapshot(")[1]?.split("\n}\n")[0] ?? ""
    const observer = iosRuntime.split("@implementation AlookKeyboardLayoutView")[1]?.split("@end")[0] ?? ""
    const handler = iosRuntime.split("@implementation AlookKeyboardHandler")[1]?.split("@end")[0] ?? ""
    const publish = iosRuntime.split("static void alookPublishKeyboardSnapshots(")[1]?.split("\n}\n")[0] ?? ""
    expect(measure).toContain("convertRect:guideFrame fromView:host")
    expect(measure).toContain("alookKeyboardBottomInset(bounds, keyboardFrame,")
    expect(measure).toContain("guideFrame, host.safeAreaLayoutGuide.layoutFrame")
    expect(measure).toContain("@\"bottomInset\"")
    expect(measure).toContain("@\"viewportWidth\"")
    expect(observer).toContain("[super layoutSubviews]")
    expect(observer).toContain("alookPublishKeyboardSnapshots(controller, NO)")
    expect(observer.indexOf("[super layoutSubviews]")).toBeLessThan(observer.indexOf("alookPublishKeyboardSnapshots(controller, NO)"))
    expect(handler).toContain("replyHandler(alookMeasureKeyboardSnapshot(controller, webView), nil)")
    expect(handler).toContain('if (![message.body isEqual:@"snapshot"])')
    expect(handler).not.toContain('isEqual:@"dismiss"')
    expect(handler).not.toContain("endEditing:")
    expect(handler).toContain("webView.superview != controller.view")
    expect(handler).not.toContain("objc_getAssociatedObject")
    expect(publish).toContain("alookMeasureKeyboardSnapshot(controller, webView)")
    const publisher = iosRuntime.split("@implementation AlookKeyboardSnapshotPublisher")[1]?.split("@end")[0] ?? ""
    expect(publish).toContain("[publisher enqueueSnapshot:snapshot]")
    expect(publisher).toContain("isEqualToDictionary:self.publishedSnapshot")
    expect(publisher).toContain("alook:keyboard-change")
  })
  it("disables the iOS input accessory in all effective main-window definitions", () => {
    for (const file of ["tauri.conf.json", "tauri.dev.conf.json", "tauri.ios.release.conf.json"]) {
      const config = JSON.parse(readFileSync(resolve(desktopRoot, file), "utf8"))
      expect(config.app.windows).toHaveLength(1)
      expect(config.app.windows[0]).toMatchObject({ label: "main", disableInputAccessoryView: true })
    }
  })
  it("matches the current paper surfaces at iOS launch and runtime", () => {
    expect(iosRuntime).toContain("colorWithRed:0.980392 green:0.964706 blue:0.933333 alpha:1.0")
    expect(iosRuntime).toContain("colorWithRed:0.0 green:0.0 blue:0.0 alpha:1.0")

    const light = iosSplash.colors.find((entry) => !entry.appearances)
    const dark = iosSplash.colors.find((entry) =>
      entry.appearances?.some(({ appearance, value }) => appearance === "luminosity" && value === "dark"),
    )
    expect(light?.color.components).toMatchObject({ red: "0.980392", green: "0.964706", blue: "0.933333" })
    expect(dark?.color.components).toMatchObject({ red: "0.000", green: "0.000", blue: "0.000" })
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
    expect(iosRuntime).toContain("alookNativeContentFrame(bounds, insets, isTauriRoot)")
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

  it("matches the current paper surfaces at Android launch and runtime", () => {
    expect(androidRuntime).toContain('const val COLOR_LIGHT = "#FAF6EE"')
    expect(androidRuntime).toContain('const val COLOR_DARK = "#000000"')
    expect(androidLightSplash).toContain("<item name=\"windowSplashScreenBackground\">#FAF6EE</item>")
    expect(androidDarkSplash).toContain("<item name=\"windowSplashScreenBackground\">#000000</item>")
    expect(androidLightSplash).toContain("<item name=\"android:statusBarColor\">#FAF6EE</item>")
    expect(androidLightSplash).toContain("<item name=\"android:navigationBarColor\">#FAF6EE</item>")
    expect(androidLightSplash).toContain("<item name=\"android:windowLightStatusBar\">true</item>")
    expect(androidLightSplash).toContain("<item name=\"android:windowLightNavigationBar\">true</item>")
    expect(androidDarkSplash).toContain("<item name=\"android:statusBarColor\">#000000</item>")
    expect(androidDarkSplash).toContain("<item name=\"android:navigationBarColor\">#000000</item>")
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


  it("retains runtime theme bridges and removes the legacy light color from native owners", () => {
    expect(iosRuntime).toContain("new MutationObserver(sync)")
    expect(iosRuntime).toContain('addScriptMessageHandler:handler name:@"alookTheme"')
    expect(androidRuntime).toContain("WebViewCompat.addDocumentStartJavaScript")

    const nativeOwners = [macosRuntime, iosRuntime, JSON.stringify(iosSplash), androidRuntime, androidLightSplash]
    for (const source of nativeOwners) {
      expect(source).not.toMatch(/#ECE8DE|0\.929[^\n]+0\.910[^\n]+0\.871/)
    }
  })
})
