export const MARKETING_SITE_LINKS = [
  { href: "/pricing", label: "Pricing", usesDocumentNavigation: false },
  { href: "/blog", label: "Blog", usesDocumentNavigation: true },
] as const

export const MARKETING_SITE_LINK_CLASS_NAME = "px-3 py-2 text-xs uppercase tracking-widest transition-opacity duration-150 hover:opacity-70"

export const MARKETING_SITE_LINK_STYLE = {
  color: "var(--landing-text)",
  fontFamily: "var(--font-mono)",
} as const
