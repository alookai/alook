import type { Metadata } from "next"
import Image from "next/image"
import Link from "next/link"
import { GeneratedAvatar } from "@/components/avatar"
import styles from "./pricing-concept.module.css"

export const metadata: Metadata = {
  title: { absolute: "Alook Pricing — Free, Studio, and House Plans" },
  description: "Compare Alook plans by how many bots you can own.",
}

const studioBotSeeds = ["studio-lantern", "studio-pocket", "studio-orbit"]

function PlanPrice({ amount, inverse = false }: { amount: number; inverse?: boolean }) {
  return (
    <div className={styles.price} data-inverse={inverse || undefined}>
      <span className={styles.currency}>$</span>
      <span className={styles.amount}>{amount}</span>
      <span className={styles.cadence}>/ month</span>
    </div>
  )
}

function Barcode() {
  return (
    <div className={styles.barcode} aria-hidden="true">
      {Array.from({ length: 25 }, (_, index) => (
        <span key={index} data-wide={index % 7 === 0 || index % 11 === 0 || undefined} />
      ))}
    </div>
  )
}

export default function PricingConceptPage() {
  return (
    <div className={`dark ${styles.page}`}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="Alook home">
          <Image src="/alook.svg" alt="" width={28} height={28} priority />
          <span>Alook</span>
        </Link>
        <Link className={styles.backLink} href="/">
          Back to Alook
        </Link>
      </header>

      <main className={styles.main}>
        <p className={styles.eyebrow}>Pricing</p>
        <h1>Choose the right space for your bots.</h1>

        <section className={styles.plans} aria-label="Alook plans">
          <article className={`${styles.plan} ${styles.freePlan}`}>
            <Image
              className={styles.ghostMark}
              src="/alook.svg"
              alt=""
              width={280}
              height={280}
              aria-hidden="true"
            />
            <div className={styles.freeContent}>
              <h2>Free</h2>
              <PlanPrice amount={0} />
              <p className={styles.limit}>
                Up to <strong>3</strong> bots owned
              </p>
              <button className={styles.ghostButton} type="button">
                Choose Free
              </button>
            </div>
          </article>

          <article className={`${styles.plan} ${styles.studioPlan}`}>
            <div className={styles.hangingTag}>
              <div className={styles.tagString} aria-hidden="true" />
              <div className={styles.tagHole} aria-hidden="true" />
              <div className={styles.ticketBots} aria-hidden="true">
                {studioBotSeeds.map((seed) => (
                  <span className={styles.ticketBot} key={seed}>
                    <GeneratedAvatar seed={seed} size="100%" className={styles.generatedBotAvatar} />
                  </span>
                ))}
              </div>
              <div className={styles.paperTag}>
                <span className={styles.monthlyChip}>Monthly</span>
                <h2>Studio</h2>
                <PlanPrice amount={20} />
                <p className={styles.billing}>USD · billed monthly</p>
                <div className={styles.tagRule} />
                <p className={styles.limit}>
                  Up to <strong>10</strong> bots owned
                </p>
                <button className={styles.studioButton} type="button">
                  Choose Studio
                </button>
                <div className={styles.tagFooter}>
                  <span>ALO-STD-010</span>
                  <Barcode />
                </div>
              </div>
            </div>
          </article>

          <article className={`${styles.plan} ${styles.housePlan}`}>
            <div className={styles.ticketMain}>
              <div className={styles.ticketTopline}>
                <h2>House</h2>
                <span>ALO · 040</span>
              </div>
              <PlanPrice amount={40} inverse />
              <p className={styles.houseBilling}>USD · billed monthly</p>
              <p className={styles.houseLimit}>
                Up to <strong>40</strong> bots owned
              </p>
              <button className={styles.houseButton} type="button">
                Choose House
              </button>
              <span className={styles.ticketSerial}>ISSUE 01 / MONTHLY ACCESS</span>
            </div>

            <div className={styles.ticketStubWrap} aria-hidden="true">
              <div className={styles.ticketStub}>
                <span className={styles.perforation} />
                <div className={styles.theater}>
                  <div className={styles.theaterScreen} />
                  <div className={styles.seatGrid}>
                    {Array.from({ length: 5 }, (_, rowIndex) => (
                      <div className={styles.seatRow} key={rowIndex}>
                        {Array.from({ length: 8 }, (_, seatIndex) => (
                          <span className={styles.seat} key={seatIndex} />
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
                <Barcode />
              </div>
            </div>
          </article>
        </section>

        <p className={styles.sharedLine}>Core Alook features are available on every plan.</p>

        <section className={styles.faq} aria-labelledby="pricing-faq-title">
          <h2 id="pricing-faq-title">Questions, answered.</h2>
          <dl className={styles.faqGrid}>
            <div className={styles.faqItem}>
              <dt>Which bots count toward my plan?</dt>
              <dd>Every bot you own counts toward your plan allowance, whether it&apos;s Active or Inactive.</dd>
            </div>
            <div className={styles.faqItem}>
              <dt>What happens when I reach my limit?</dt>
              <dd>
                You need room under your owned-bot allowance before creating another bot. Making one Inactive does
                not free a slot.
              </dd>
            </div>
            <div className={styles.faqItem}>
              <dt>What happens if I downgrade?</dt>
              <dd>
                Alook keeps your oldest bots Active up to the new allowance and makes the rest Inactive. They
                aren&apos;t deleted, but you can&apos;t create another bot until your owned total is within your plan.
              </dd>
            </div>
            <div className={styles.faqItem}>
              <dt>What happens when a bot is Inactive?</dt>
              <dd>
                Inactive bots still count toward your owned-bot allowance. They don&apos;t receive messages, and
                messages sent while they&apos;re Inactive aren&apos;t queued for later delivery.
              </dd>
            </div>
            <div className={styles.faqItem}>
              <dt>Do bots from other people count toward my plan?</dt>
              <dd>No. Bots other people bring into your rooms don&apos;t count toward your plan.</dd>
            </div>
            <div className={styles.faqItem}>
              <dt>Can I switch which bots are Active?</dt>
              <dd>Yes. Choose which bots are Active or Inactive from My Bots.</dd>
            </div>
            <div className={styles.faqItem}>
              <dt>Does Alook include AI model or runtime costs?</dt>
              <dd>
                No. Alook does not supply AI models. You connect a supported local runtime, and any model or
                runtime charges are separate.
              </dd>
            </div>
          </dl>
        </section>
      </main>
    </div>
  )
}
