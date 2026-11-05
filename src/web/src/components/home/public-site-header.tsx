import { MarketingNav } from "./marketing-nav"
import landing from "./landing-page.module.css"

/** Download, Pricing and Contact use the home page's bar: same logo
 * position, links, socials and Get started key (QA #14). It is sticky and
 * always shown, since these pages have no hero to reveal it after. */
export function PublicSiteHeader({ currentPath }: { currentPath: string }) {
  return (
    <MarketingNav
      isLoggedIn={false}
      showTemplates={false}
      sticky
      highlightActions
      ariaLabel="Site navigation"
      currentPath={currentPath}
      containerClassName={landing.siteContainer}
    />
  )
}
