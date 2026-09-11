"use client"

import Image from "next/image"
import Link from "next/link"
import { PlanBots, PlanBarcode } from "@/components/pricing/plan-art"
import styles from "./pricing.module.css"
import type { PricingController } from "./pricing-client"

function PricingPrice({ offer, free, className, inverse }: { offer?: import("@alook/shared").BillingOffer; free?: boolean; className: string; inverse?: boolean }) {
  if (free) return <div className={className}><span className={styles.currency}>$</span><span className={styles.amount}>0</span><span className={styles.cadence}> / month</span></div>
  if (!offer) return <div className={className} aria-label="Price unavailable"><span className={styles.amount}>—</span></div>
  const currency = offer.currency.toUpperCase()
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2
  const parts = new Intl.NumberFormat("en", { style: "currency", currency, minimumFractionDigits: 0 }).formatToParts(offer.unitAmount / 10 ** digits)
  const symbol = parts.find((part) => part.type === "currency")?.value ?? currency
  const amount = parts.filter((part) => part.type !== "currency" && part.type !== "literal").map((part) => part.value).join("")
  const interval = offer.intervalCount === 1 ? offer.interval : `${offer.intervalCount} ${offer.interval}s`
  return <div className={className} data-inverse={inverse || undefined}><span className={styles.currency}>{symbol}</span><span className={styles.amount}>{amount}</span><span className={styles.cadence}>{currency} / {interval}</span></div>
}

export function PricingView({ controller: c }: { controller: PricingController }) {
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

        <div className={styles.status} aria-live="polite">{c.message}</div>
        {c.error && <div className={styles.status} role="alert">{c.error} <button type="button" onClick={c.retry}>Try again</button></div>}
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
              <PricingPrice free className={styles.price} />
              <p className={styles.limit}>
                Up to <strong>{c.catalog?.free.botLimit ?? "—"}</strong> active bots
              </p>
              <p className={styles.limit}>Up to <strong>{c.catalog?.free.machineLimit ?? "—"}</strong> online machine{c.catalog?.free.machineLimit === 1 ? "" : "s"}</p>
              <button className={styles.ghostButton} type="button" disabled={c.disabled("free")} onClick={() => c.choose("free")} data-testid="pricing-choose-free">
                {c.label("free")}
              </button>
            </div>
          </article>

          <article className={`${styles.plan} ${styles.studioPlan}`}>
            <div className={styles.hangingTag}>
              <div className={styles.tagString} aria-hidden="true" />
              <div className={styles.tagHole} aria-hidden="true" />
              <PlanBots className={styles.ticketBots} botClassName={styles.ticketBot} avatarClassName={styles.generatedBotAvatar} />
              <div className={styles.paperTag}>
                <span className={styles.monthlyChip}>Monthly</span>
                <h2>Studio</h2>
                <PricingPrice offer={c.offer("studio")} className={styles.price} />

                <div className={styles.tagRule} />
                <p className={styles.limit}>
                  Up to <strong>{c.offer("studio")?.botLimit ?? "—"}</strong> active bots
                </p>
                <p className={styles.limit}>Up to <strong>{c.offer("studio")?.machineLimit ?? "—"}</strong> online machine{c.offer("studio")?.machineLimit === 1 ? "" : "s"}</p>
                <button className={styles.studioButton} type="button" disabled={c.disabled("studio")} onClick={() => c.choose("studio")} data-testid="pricing-choose-studio">
                {c.label("studio")}
                </button>
                <div className={styles.tagFooter}>
                  <span>ALO-STD-010</span>
                  <PlanBarcode className={styles.barcode} />
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
              <PricingPrice offer={c.offer("house")} className={styles.price} inverse />

              <p className={styles.houseLimit}>
                Up to <strong>{c.offer("house")?.botLimit ?? "—"}</strong> active bots
              </p>
              <p className={styles.houseLimit}>Up to <strong>{c.offer("house")?.machineLimit ?? "—"}</strong> online machine{c.offer("house")?.machineLimit === 1 ? "" : "s"}</p>
              <button className={styles.houseButton} type="button" disabled={c.disabled("house")} onClick={() => c.choose("house")} data-testid="pricing-choose-house">
                {c.label("house")}
              </button>
              <span className={styles.ticketSerial}>ISSUE 01 / MONTHLY ACCESS</span>
            </div>

            <div className={styles.ticketStubWrap} aria-hidden="true">
              <div className={styles.ticketStub}>
                <span className={styles.perforation} />
                <div className={styles.theater}>
                  <div className={styles.theaterScreen} />
                  <div className={styles.seatGrid}>
                    {Array.from({ length: Math.ceil((c.offer("house")?.botLimit ?? 0) / 8) }, (_, rowIndex) => (
                      <div className={styles.seatRow} key={rowIndex}>
                        {Array.from({ length: Math.min(8, (c.offer("house")?.botLimit ?? 0) - rowIndex * 8) }, (_, seatIndex) => (
                          <span className={styles.seat} key={seatIndex} />
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
                <PlanBarcode className={styles.barcode} />
              </div>
            </div>
          </article>
        </section>

        <p className={styles.sharedLine}>Core Alook features are available on every plan.</p>

        <section className={styles.faq} aria-labelledby="pricing-faq-title">
          <h2 id="pricing-faq-title">Questions, answered.</h2>
          <dl className={styles.faqGrid}>
            <div className={styles.faqItem}>
              <dt>Which machines count toward my plan?</dt>
              <dd>Every machine you own counts, including offline machines. Disconnecting one does not make room for another. If you downgrade, newer excess machines are disconnected; your machines and bots are kept.</dd>
            </div>
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
                Alook keeps your oldest active bots Active up to the new allowance and makes the rest Inactive. They
                aren&apos;t deleted, but you can&apos;t create another bot until your owned total is below your plan’s limit.
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
