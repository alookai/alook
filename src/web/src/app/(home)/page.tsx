import type { Metadata } from "next";
import {
  LANDING_META_DESCRIPTION,
  LANDING_META_TITLE,
} from "@/components/home/landing-content";
import { LandingPage } from "@/components/home/landing-page";
import { getSession } from "@/lib/session";

const title = LANDING_META_TITLE;
const description = LANDING_META_DESCRIPTION;
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
  },
  twitter: {
    card: "summary_large_image",
    site: "@alook_ai",
    title,
    description,
  },
};

export default async function Page() {
  const session = await getSession();
  return <LandingPage isLoggedIn={!!session} />;
}
