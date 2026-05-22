import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How Alook collects, uses, and protects your personal information.",
  alternates: { canonical: "https://alook.ai/privacy" },
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 pt-12 sm:pt-24 pb-28">
      <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight mb-4">
        Privacy Policy
      </h1>
      <p className="text-sm text-muted-foreground mb-12">
        Last updated: May 22, 2026
      </p>

      <div className="prose prose-neutral dark:prose-invert max-w-none space-y-8 text-[1.0625rem] leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold mt-10 mb-4">1. Information We Collect</h2>
          <p className="text-foreground/80">
            When you use Alook, we collect information you provide directly — such as
            your email address when you sign up, and any content you send to or through
            your AI agents. We also collect usage data (pages visited, features used) to
            improve the service.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mt-10 mb-4">2. How We Use Your Information</h2>
          <p className="text-foreground/80">We use your information to:</p>
          <ul className="list-disc pl-6 mt-3 space-y-2 text-foreground/80">
            <li>Provide, maintain, and improve Alook services</li>
            <li>Process and deliver agent tasks on your behalf</li>
            <li>Send service-related communications</li>
            <li>Protect against fraud and abuse</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold mt-10 mb-4">3. Data Storage &amp; Security</h2>
          <p className="text-foreground/80">
            Your data is stored securely using industry-standard encryption. Agent
            workspaces are isolated per user. We do not sell your personal data to third
            parties.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mt-10 mb-4">4. Third-Party Services</h2>
          <p className="text-foreground/80">
            Alook integrates with third-party AI model providers to power agent
            capabilities. Data sent to these providers is governed by their respective
            privacy policies. We minimize the data shared and only send what is necessary
            to fulfill your requests.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mt-10 mb-4">5. Your Rights</h2>
          <p className="text-foreground/80">
            You can request access to, correction of, or deletion of your personal data
            at any time by contacting us at{" "}
            <a
              href="mailto:support@alook.ai"
              className="underline underline-offset-3 decoration-foreground/30 hover:decoration-foreground/60 transition-colors"
            >
              support@alook.ai
            </a>
            .
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mt-10 mb-4">6. Changes to This Policy</h2>
          <p className="text-foreground/80">
            We may update this policy from time to time. We will notify you of material
            changes by posting the new policy on this page and updating the &quot;Last
            updated&quot; date.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mt-10 mb-4">7. Contact Us</h2>
          <p className="text-foreground/80">
            If you have questions about this Privacy Policy, please contact us at{" "}
            <a
              href="mailto:support@alook.ai"
              className="underline underline-offset-3 decoration-foreground/30 hover:decoration-foreground/60 transition-colors"
            >
              support@alook.ai
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
