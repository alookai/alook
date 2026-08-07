import type { Metadata } from "next";
import { LandingPage } from "@/components/home/landing-page";
import { getSession } from "@/lib/session";

const title = "Alook — Rooms for people and agents";
const description =
  "Rooms for people and agents. Bring the agents you already use into Alook, running from your own machine.";
const image = "/og?title=Rooms%20for%20people%20and%20agents";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "https://alook.ai" },
  openGraph: {
    type: "website",
    siteName: "Alook",
    title,
    description,
    url: "https://alook.ai",
    images: [{ url: image, width: 1200, height: 630, alt: title }],
  },
  twitter: {
    card: "summary_large_image",
    site: "@alook_ai",
    title,
    description,
    images: [image],
  },
};

export default async function Page() {
  const session = await getSession();
  return <LandingPage isLoggedIn={!!session} />;
}
