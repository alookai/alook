import { ObservedStaticContent } from "@/lib/observability/regions";
import {
  LANDING_META_DESCRIPTION,
  LANDING_META_TITLE,
} from "@/components/home/landing-content";
import { LandingPage } from "@/components/home/landing-page";
import { headers } from "next/headers";
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata";

export const metadata = buildPublicPageMetadata({
  title: LANDING_META_TITLE,
  description: LANDING_META_DESCRIPTION,
  path: "/",
});

export default async function Page() {
  const requestHeaders = await headers();
  const hasCredentials = requestHeaders.has("cookie") || requestHeaders.has("authorization");
  const session = hasCredentials ? await (await import("@/lib/session")).getSession() : null;
  return <><ObservedStaticContent /><LandingPage isLoggedIn={!!session} /></>;
}
