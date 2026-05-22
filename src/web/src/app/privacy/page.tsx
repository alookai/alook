import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How Alook collects, uses, and protects your personal information.",
  alternates: { canonical: "https://alook.ai/privacy" },
};

const linkClass =
  "underline underline-offset-3 decoration-foreground/30 hover:decoration-foreground/60 transition-colors";

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
          <h2 className="text-xl font-semibold mt-10 mb-4">Interpretation and Definitions</h2>
          <p className="text-foreground/80">
            In this Privacy Policy, &quot;Company&quot; (referred to as &quot;We&quot;, &quot;Us&quot;, or &quot;Our&quot;)
            refers to Alook AI. &quot;Service&quot; refers to the Alook platform accessible at{" "}
            <a href="https://alook.ai" className={linkClass}>alook.ai</a>.
            &quot;You&quot; means the individual accessing or using our Service.
            &quot;Personal Data&quot; is any information that relates to an identified or identifiable individual.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mt-10 mb-4">Collecting and Using Your Personal Data</h2>

          <h3 className="text-lg font-medium mt-8 mb-3">Types of Data Collected</h3>

          <h4 className="text-base font-medium mt-6 mb-2">Personal Data</h4>
          <p className="text-foreground/80">
            While using Our Service, We may ask You to provide Us with certain personally
            identifiable information that can be used to contact or identify You, including
            but not limited to:
          </p>
          <ul className="list-disc pl-6 mt-3 space-y-2 text-foreground/80">
            <li>Email address</li>
            <li>Name</li>
            <li>Usage data</li>
          </ul>

          <h4 className="text-base font-medium mt-6 mb-2">Usage Data</h4>
          <p className="text-foreground/80">
            Usage Data is collected automatically when using the Service. It may include
            information such as Your device&apos;s IP address, browser type, browser version,
            the pages of our Service that You visit, the time and date of Your visit,
            the time spent on those pages, and other diagnostic data.
          </p>

          <h4 className="text-base font-medium mt-6 mb-2">Information from Third-Party Social Login</h4>
          <p className="text-foreground/80">
            Alook allows You to create an account and log in through third-party services
            including Google and GitHub. If You decide to register through or grant us access
            to a third-party service, We may collect Personal Data already associated with
            Your account, such as Your name and email address.
          </p>

          <h4 className="text-base font-medium mt-6 mb-2">Tracking Technologies and Cookies</h4>
          <p className="text-foreground/80">
            We use cookies and similar tracking technologies to track activity on Our Service
            and store certain information. These are used to analyze trends, administer the
            site, and gather demographic information. You can instruct Your browser to refuse
            all cookies or to indicate when a cookie is being sent.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mt-10 mb-4">Use of Your Personal Data</h2>
          <p className="text-foreground/80">We may use Your Personal Data for the following purposes:</p>
          <ul className="list-disc pl-6 mt-3 space-y-2 text-foreground/80">
            <li><strong>To provide and maintain our Service</strong>, including processing and delivering AI agent tasks on your behalf.</li>
            <li><strong>To manage Your Account</strong> and provide You with access to functionalities of the Service available to registered users.</li>
            <li><strong>To contact You</strong> by email or other equivalent forms of electronic communication regarding updates or informative communications related to the Service.</li>
            <li><strong>To manage Your requests</strong> and attend to any requests You make to Us.</li>
            <li><strong>For business transfers</strong> in connection with any merger, sale of company assets, financing, or acquisition of all or a portion of Our business.</li>
            <li><strong>For other purposes</strong> such as data analysis, identifying usage trends, and improving our Service.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold mt-10 mb-4">Sharing Your Personal Data</h2>
          <p className="text-foreground/80">We may share Your personal information in the following situations:</p>
          <ul className="list-disc pl-6 mt-3 space-y-2 text-foreground/80">
            <li><strong>With Service Providers:</strong> We share data with third-party AI model providers to power agent capabilities. Data sent to these providers is governed by their respective privacy policies. We minimize the data shared and only send what is necessary to fulfill Your requests.</li>
            <li><strong>For business transfers:</strong> In connection with a merger, acquisition, or asset sale, Your Personal Data may be transferred.</li>
            <li><strong>With Your consent:</strong> We may disclose Your personal information for any other purpose with Your consent.</li>
          </ul>
          <p className="text-foreground/80 mt-4">
            We do not sell Your Personal Data to third parties.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mt-10 mb-4">Retention of Your Personal Data</h2>
          <p className="text-foreground/80">
            We will retain Your Personal Data only for as long as is necessary for the
            purposes set out in this Privacy Policy. We will retain and use Your data to
            the extent necessary to comply with our legal obligations, resolve disputes,
            and enforce our agreements.
          </p>
          <p className="text-foreground/80 mt-4">
            Usage Data is generally retained for a shorter period of time, except when it
            is used to strengthen security or improve the functionality of Our Service.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mt-10 mb-4">Security of Your Personal Data</h2>
          <p className="text-foreground/80">
            The security of Your Personal Data is important to Us. Your data is stored
            securely using industry-standard encryption. Agent workspaces are isolated per
            user. However, no method of transmission over the Internet or method of electronic
            storage is 100% secure. While We strive to use commercially acceptable means to
            protect Your Personal Data, We cannot guarantee its absolute security.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mt-10 mb-4">Children&apos;s Privacy</h2>
          <p className="text-foreground/80">
            Our Service does not address anyone under the age of 13. We do not knowingly
            collect personally identifiable information from anyone under the age of 13.
            If You are a parent or guardian and You are aware that Your child has provided
            Us with Personal Data, please contact Us. If We become aware that We have
            collected Personal Data from anyone under the age of 13 without verification
            of parental consent, We will take steps to remove that information.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mt-10 mb-4">Your Data Rights</h2>
          <p className="text-foreground/80">
            You have the right to access, update, or delete Your Personal Data at any time.
            You can manage certain information through Your Account settings, or contact Us
            directly to request assistance with these actions.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mt-10 mb-4">Changes to This Privacy Policy</h2>
          <p className="text-foreground/80">
            We may update Our Privacy Policy from time to time. We will notify You of any
            changes by posting the new Privacy Policy on this page and updating the
            &quot;Last updated&quot; date at the top. You are advised to review this Privacy
            Policy periodically for any changes.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mt-10 mb-4">Contact Us</h2>
          <p className="text-foreground/80">
            If you have any questions about this Privacy Policy, You can contact us at{" "}
            <a href="mailto:support@alook.ai" className={linkClass}>
              support@alook.ai
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
