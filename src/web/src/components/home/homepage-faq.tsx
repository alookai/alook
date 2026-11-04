import styles from "./landing-page.module.css"
import { HandAccent } from "@/components/brand/hand-accent"
import { Card } from "@/components/ui/card"
import { FAQ_PAGE_SCHEMA, HOME_FAQS } from "./landing-content"

const FAQ_PAGE_SCHEMA_JSON = JSON.stringify(FAQ_PAGE_SCHEMA).replace(/</g, "\\u003c")

export function HomepageFaq() {
  return (
    <section
      id="faq"
      className={styles.faqSection}
      aria-labelledby="homepage-faq-heading"
      data-testid="landing-faq"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: FAQ_PAGE_SCHEMA_JSON }}
      />
      <div className={styles.faqLayout} data-landing-scroll-anchor>
        <div className={styles.faqIntro}>
          <p className={`${styles.sectionMuted} ${styles.faqKicker}`}>Alook, in plain terms</p>
          <h2 id="homepage-faq-heading">Questions, <HandAccent>answered</HandAccent></h2>
          <p>What runs where, who stays in control, and how Alook fits beside the tools you already use.</p>
        </div>
        <Card className={styles.faqList}>
          {HOME_FAQS.map(({ question, answer, link }) => (
            <details key={question} className={styles.faqItem}>
              <summary>
                <span>{question}</span>
                <span className={styles.faqMarker} aria-hidden="true" />
              </summary>
              <div className={styles.faqAnswer}>
                {answer.split("\n\n").map((paragraph) => (
                  <p key={paragraph}>
                    {link && paragraph.includes(link.label) ? (
                      <>
                        {paragraph.split(link.label)[0]}
                        <a href={link.href}>{link.label}</a>
                        {paragraph.split(link.label)[1]}
                      </>
                    ) : paragraph}
                  </p>
                ))}
              </div>
            </details>
          ))}
        </Card>
      </div>
    </section>
  )
}
