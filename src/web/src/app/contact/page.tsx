import { DISCORD_INVITE_URL } from "@/lib/discord-invite"
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata"
import Image from "next/image"
import { ArrowUpRight, CalendarDays, Mail } from "lucide-react"
import { SiDiscord, SiX } from "@icons-pack/react-simple-icons"
import { PublicSiteHeader } from "@/components/home/public-site-header"
import { LandingFooter } from "@/components/home/landing-footer"
import landing from "@/components/home/landing-page.module.css"
import styles from "./contact.module.css"
import { HandAccent } from "@/components/brand/hand-accent"

export const metadata = buildPublicPageMetadata({
  title: "Contact — Alook",
  description: "Contact Gus, the builder of Alook, by email or book a 15-minute conversation. Find the Alook Support community and Discord for questions and feedback.",
  path: "/contact",
})

const contacts = [
  { icon: Mail, label: "Email", text: "gus@memodb.io", href: "mailto:gus@memodb.io" },
  { icon: CalendarDays, label: "Meet", text: "Book 15 minutes", href: "https://cal.com/gustavoye/15min" },
  { icon: SiX, label: "X", text: "@im_gusye", href: "https://x.com/im_gusye" },
]

export default function ContactPage() {
  return (
    <div className={`landing ${landing.page} ${styles.page}`}>
      <PublicSiteHeader currentPath="/contact" />
      <main className={styles.main}>
        <section data-slot="landing-closing" className={`${landing.closingCta} ${styles.sheet}`} aria-labelledby="contact-heading">
          <p className={styles.kicker}>Contact</p>
          <h1 id="contact-heading">Let’s <HandAccent>talk.</HandAccent></h1>
          <div className={styles.groups}>
            <section aria-labelledby="gus-heading">
              <div className={styles.identity}>
                <span className={styles.avatar}>
                  <Image src="/contact/gus-photo.jpeg" alt="Gus" width={128} height={128} />
                </span>
                <div>
                  <h2 id="gus-heading">Gus</h2>
                  <p className={styles.role}>Builder &amp; Founder of Alook</p>
                </div>
              </div>
              <ul className={styles.contacts}>
                {contacts.map(({ icon: Icon, label, text, href }) => (
                  <li key={label}>
                    <a href={href} className={styles.contact}>
                      <span className={styles.label}><Icon size={16} aria-hidden="true" />{label}</span>
                      <span className={styles.value}>{text}</span>
                      <ArrowUpRight size={20} aria-hidden="true" />
                    </a>
                  </li>
                ))}
              </ul>
            </section>
            <section className={styles.community} aria-labelledby="community-heading">
              <h2 id="community-heading">Community</h2>
              <a href="https://alook.ai/c/invite/nC7ax53lwm" className={styles.communityLink}>
                <Image src="/favicon.ico" alt="" width={20} height={20} /><span>Alook Support</span><ArrowUpRight size={20} aria-hidden="true" />
              </a>
              <a href={DISCORD_INVITE_URL} className={styles.communityLink}>
                <SiDiscord size={20} aria-hidden="true" /><span>Discord</span><ArrowUpRight size={20} aria-hidden="true" />
              </a>
            </section>
          </div>
        </section>
      </main>
      <LandingFooter />
    </div>
  )
}
