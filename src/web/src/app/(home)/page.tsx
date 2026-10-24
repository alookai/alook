import { ObservedStaticContent } from "@/lib/observability/regions";
import {
  LANDING_META_DESCRIPTION,
  LANDING_META_TITLE,
} from "@/components/home/landing-content";
import { SessionLandingPage } from "@/components/home/session-landing-page";
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata";

export const metadata = buildPublicPageMetadata({
  title: LANDING_META_TITLE,
  description: LANDING_META_DESCRIPTION,
  path: "/",
});

export default function Page() {
  return <><ObservedStaticContent /><SessionLandingPage /></>;
}
