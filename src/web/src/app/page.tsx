import type { Metadata } from "next";
import { getSession } from "@/lib/session";
import { HomePage } from "@/components/home/home-page";
import { WorkspaceRedirect } from "@/components/workspace-redirect";

export const metadata: Metadata = {
  title: "Alook — Always-on AI Agents",
  description:
    "Your AI agents, always on. Give them an email, let them work for you around the clock.",
  alternates: { canonical: "https://alook.ai" },
};

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "What is Alook?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Alook is a platform that gives your AI agents an email address and keeps them always on. They can receive tasks via email, process them autonomously, and respond — around the clock.",
      },
    },
    {
      "@type": "Question",
      name: "How do I communicate with my AI agent?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Each agent gets its own @alook.ai email address. You can send instructions via email, and the agent will process them and reply. You can also interact through the Alook dashboard.",
      },
    },
    {
      "@type": "Question",
      name: "Is Alook free to use?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes, Alook offers a free tier to get started with always-on AI agents.",
      },
    },
  ],
};

export default async function Page() {
  const session = await getSession();
  if (session) return <WorkspaceRedirect />;
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <HomePage isLoggedIn={false} />
    </>
  );
}
