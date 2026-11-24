export const MARKETING_SITE_LINKS = [
  { href: "/usecases", label: "Use Cases", usesDocumentNavigation: true },
  { href: "/download", label: "Download", usesDocumentNavigation: false },
  { href: "/pricing", label: "Pricing", usesDocumentNavigation: false },
  { href: "/blog", label: "Blog", usesDocumentNavigation: true },
  { href: "/contact", label: "Contact", usesDocumentNavigation: false },
] as const

export const MARKETING_FOOTER_LINKS = [
  { href: "/usecases", label: "Use Cases", usesDocumentNavigation: true },
  { href: "/download", label: "Download", usesDocumentNavigation: false },
  { href: "/pricing", label: "Pricing", usesDocumentNavigation: false },
  { href: "/blog", label: "Blog", usesDocumentNavigation: true },
  { href: "/compare", label: "Compare", usesDocumentNavigation: false },
  { href: "/contact", label: "Contact", usesDocumentNavigation: false },
] as const

export const MARKETING_SITE_LINK_CLASS_NAME = "whitespace-nowrap px-3 py-2 text-sm transition-opacity duration-150 hover:opacity-70 aria-[current=page]:underline aria-[current=page]:underline-offset-6"

export const MARKETING_SITE_LINK_STYLE = {
  color: "var(--landing-text)",
  // Sans, like the footer and the page copy (QA #15).
  fontFamily: "var(--font-sans)",
} as const
