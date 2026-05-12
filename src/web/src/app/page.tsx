import type { Metadata } from "next";
import dynamic from "next/dynamic";
import { getSession } from "@/lib/session";


const HomePage = dynamic(() => import("@/components/home/home-page").then(m => ({ default: m.HomePage })), {
  ssr: true,
});

export const metadata: Metadata = {
  title: "Alook — Your Personal Company",
  description:
    "Run your personal company with AI agents that collaborate, stay always on, and learn from every task. Give each agent an email, assign roles, and let them work for you around the clock.",
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
        text: "Alook is the orchestration layer for your personal company. It lets you define roles, assign AI agents, and keep them collaborating, always on, and self-learning — like running a company with an AI workforce.",
      },
    },
    {
      "@type": "Question",
      name: "How do I communicate with my AI agents?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Each agent gets its own @alook.ai email address. You can send instructions via email, and agents collaborate on tasks and reply. You can also manage your company through the Alook dashboard.",
      },
    },
    {
      "@type": "Question",
      name: "Is Alook free to use?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes, Alook offers a free tier to get started with Your Personal Company.",
      },
    },
  ],
};

export default async function Page() {
  const session = await getSession();
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <HomePage isLoggedIn={!!session} />
    </>
  );
}
