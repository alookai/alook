import Image from "next/image"
import Link from "next/link"
import { MARKETING_SITE_LINKS } from "./marketing-site-links"
import landing from "./landing-page.module.css"
import styles from "./public-site-header.module.css"

export function PublicSiteHeader({ currentPath }: { currentPath: string }) {
  return <header className={styles.header}>
    <Link href="/" className={landing.brand} aria-label="Alook home">
      <Image src="/alook.svg" alt="" width={28} height={28} />
      <span>Alook</span>
    </Link>
    <nav className={styles.links} aria-label="Site navigation">
      {MARKETING_SITE_LINKS.map(link => link.usesDocumentNavigation
        ? <a key={link.href} href={link.href} aria-current={currentPath === link.href ? "page" : undefined}>{link.label}</a>
        : <Link key={link.href} href={link.href} aria-current={currentPath === link.href ? "page" : undefined}>{link.label}</Link>)}
    </nav>
    <Link href="/" className={styles.back}>Back to home</Link>
  </header>
}
