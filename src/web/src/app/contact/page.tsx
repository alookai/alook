import type { Metadata } from "next"
import Image from "next/image"
import Link from "next/link"
import { ArrowUpRight, CalendarDays, Mail } from "lucide-react"
import { SiDiscord } from "@icons-pack/react-simple-icons"
import { LandingFooter } from "@/components/home/landing-footer"
import landing from "@/components/home/landing-page.module.css"
import styles from "./contact.module.css"

export const metadata: Metadata = {
  title: { absolute: "Contact — Alook" },
  description: "Get in touch with Gus, book a conversation, or reach Alook Support.",
  alternates: { canonical: "/contact" },
}

const contacts = [
  { icon: Mail, label: "Email", text: "gus@memodb.io", href: "mailto:gus@memodb.io" },
  { icon: CalendarDays, label: "Meet", text: "Book 15 minutes", href: "https://cal.com/gustavoye/15min" },
]

export default function ContactPage() {
  return (
    <div className={`landing ${landing.page} ${styles.page}`}>
      <header className={styles.header}>
        <Link href="/" className={landing.brand} aria-label="Alook home">
          <Image src="/alook.svg" alt="" width={28} height={28} />
          <span>Alook</span>
        </Link>
        <Link href="/" className={styles.back}>Back to home</Link>
      </header>
      <main className={styles.main}>
        <section className={`${landing.closingCta} ${styles.sheet}`} aria-labelledby="contact-heading">
          <h1 id="contact-heading">Let’s talk.</h1>
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
              <a href="https://discord.alook.ai" className={styles.communityLink}>
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
