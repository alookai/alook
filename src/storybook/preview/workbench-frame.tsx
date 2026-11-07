import { useEffect, type ReactNode } from "react"
import { useTheme } from "next-themes"
import { ThemeProvider } from "../../web/src/components/theme-provider"
import { TooltipProvider } from "../../web/src/components/ui/tooltip"
import theme from "../../web/src/components/brand/technostalgia.module.css"
import { caveat, dmMono, dmSans, instrumentSerif, literata, vt323 } from "../../web/src/app/fonts"

const fonts = [dmSans, dmMono, instrumentSerif, caveat, vt323, literata].map((font) => font.variable)
const blogScopes = new Set<symbol>()
let appearanceActive = false

function applyDocumentSurface() {
  if (!appearanceActive) return
  document.body.classList.toggle(theme.theme, blogScopes.size === 0)
  document.body.classList.toggle("blog-shell", blogScopes.size > 0)
}

export function installDocumentAppearance() {
  appearanceActive = true
  applyDocumentSurface()
  document.documentElement.classList.add(...fonts)
  return () => {
    appearanceActive = false
    blogScopes.clear()
    document.body.classList.remove(theme.theme)
    document.body.classList.remove("blog-shell")
    document.documentElement.classList.remove(...fonts)
  }
}

export function installStoryDocumentAppearance(title: string) {
  if (!title.startsWith("Blog/")) return
  const scope = Symbol(title)
  blogScopes.add(scope)
  applyDocumentSurface()
  return () => {
    blogScopes.delete(scope)
    applyDocumentSurface()
  }
}

function ToolbarThemeSync({ mode }: { mode: string }) {
  const { theme, setTheme } = useTheme()
  useEffect(() => {
    if (theme !== mode) setTheme(mode)
  }, [mode, setTheme, theme])
  return null
}

export function WorkbenchFrame({ mode, blog = false, children }: { mode: string; blog?: boolean; children: ReactNode }) {
  return (
    <ThemeProvider attribute={["class", "data-tn-mode"]} forcedTheme={mode} defaultTheme={mode} enableSystem={false} storageKey="storybook-theme">
      <ToolbarThemeSync mode={mode} />
      <div data-slot="app-safe-bounds" aria-hidden className="app-safe-viewport app-safe-overlay-viewport pointer-events-none invisible fixed" />
      <TooltipProvider><div data-storybook-product-surface className={blog ? "blog-shell" : theme.theme}>{children}</div></TooltipProvider>
    </ThemeProvider>
  )
}
