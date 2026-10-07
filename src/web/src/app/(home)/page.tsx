import { ObservedStaticContent } from "@/lib/observability/regions";
import type { Metadata } from "next";
import {
  LANDING_META_DESCRIPTION,
  LANDING_META_TITLE,
} from "@/components/home/landing-content";
import { LandingPage } from "@/components/home/landing-page";
import { getSession } from "@/lib/session";
import { SITE_OG_IMAGE } from "@/lib/seo/site-metadata";

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
    images: [SITE_OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    site: "@alook_ai",
    title,
    description,
    images: [SITE_OG_IMAGE],
  },
};

export default async function Page() {
  const session = await getSession();
  return <><ObservedStaticContent /><LandingPage isLoggedIn={!!session} /></>;
}
