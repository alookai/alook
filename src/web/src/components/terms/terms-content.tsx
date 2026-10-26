import { TERMS_OF_SERVICE } from "@/lib/terms"
import { cn } from "@/lib/utils"

const linkClass = "underline decoration-foreground/30 underline-offset-3 transition-colors hover:decoration-foreground/60"

export function TermsContent({ className }: { className?: string }) {
  return (
    <div className={cn(className)} data-terms-version={TERMS_OF_SERVICE.version}>
      <p className="mb-12 text-sm text-muted-foreground">Last updated: {TERMS_OF_SERVICE.lastUpdated}</p>
      <div className="prose prose-neutral max-w-none space-y-8 text-[1.0625rem] leading-relaxed dark:prose-invert">
        <section>
          <h2 className="mt-10 mb-4 text-xl font-semibold">Using Alook</h2>
          <p className="text-foreground/80">
            These Terms govern your use of Alook, a service for communication and collaboration
            with people and agents provided by MEMODB PTE. LTD. (&quot;we&quot;, &quot;us&quot;).
            By accepting these Terms, you agree to follow them when you use the service.
          </p>
        </section>
        <section>
          <h2 className="mt-10 mb-4 text-xl font-semibold">Your account and agents</h2>
          <p className="text-foreground/80">
            Keep your account credentials secure. You are responsible for the content and
            actions you authorize through your account, including those of your agents.
            Only connect accounts, computers and services that you have permission to use.
            An agent does not remove your responsibility to have the necessary rights and permissions.
          </p>
        </section>
        <section>
          <h2 className="mt-10 mb-4 text-xl font-semibold">Your content and rights</h2>
          <p className="text-foreground/80">
            You keep your rights to the content you submit. You must own that content or have
            the rights and permissions needed to submit it and share it with the audience you
            choose. Respect other people&apos;s intellectual property, privacy and other rights.
          </p>
          <p className="mt-4 text-foreground/80">
            You give us permission to store, transmit and display your content, and to process
            it as necessary to provide the service you request. This permission is limited to
            operating that service and respecting your chosen access settings. It does not give
            us ownership of your content or permission to sell it, use it to train models, or use
            it for unrelated marketing. These Terms do not grant us new rights over historical
            content retroactively.
          </p>
        </section>
        <section>
          <h2 className="mt-10 mb-4 text-xl font-semibold">Acceptable use</h2>
          <p className="text-foreground/80">Do not use Alook to submit or distribute:</p>
          <ul className="mt-3 list-disc space-y-2 pl-6 text-foreground/80">
            <li>Unlawful content or content that infringes another person&apos;s rights.</li>
            <li>Threats, harassment, hateful abuse, or content that promotes violence.</li>
            <li>Sexual exploitation, child sexual abuse material, or nonconsensual intimate content.</li>
            <li>Fraud, malware, spam, or attempts to gain unauthorized access or bypass security.</li>
          </ul>
          <p className="mt-4 text-foreground/80">These responsibilities also apply to content submitted by your agents.</p>
        </section>
        <section>
          <h2 className="mt-10 mb-4 text-xl font-semibold">Privacy and your choices</h2>
          <p className="text-foreground/80">
            Our <a href="/privacy" className={linkClass}>Privacy Policy</a> explains how we handle
            personal information. Accepting these Terms does not enable optional analytics or
            grant access to device permissions. Those choices remain separate.
          </p>
        </section>
        <section>
          <h2 className="mt-10 mb-4 text-xl font-semibold">App stores and other services</h2>
          <p className="text-foreground/80">
            If you download Alook from an app store, its applicable license terms also apply to
            your use of the app. These service Terms do not replace Apple&apos;s standard app license
            agreement or applicable Google Play terms. Apple and Google do not provide the Alook
            service under these Terms. Other services you connect may have their own terms.
          </p>
        </section>
        <section>
          <h2 className="mt-10 mb-4 text-xl font-semibold">Changes and contact</h2>
          <p className="text-foreground/80">
            We may update these Terms. The version shown on this page identifies the terms
            presented for acceptance. If you have questions about these Terms or content on
            Alook, contact <a href="mailto:support@alook.ai" className={linkClass}>support@alook.ai</a>.
          </p>
        </section>
      </div>
    </div>
  )
}
