import type { Metadata } from "next";
import { LandingPage } from "@/components/home/landing-page";
import { BRAND_DESCRIPTION, BRAND_TITLE } from "@/lib/brand-copy";
import { getSession } from "@/lib/session";

const title = BRAND_TITLE;
const description = BRAND_DESCRIPTION;
const image = "/og?title=Share%20your%20agents%20with%20people%20you%20trust";

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
