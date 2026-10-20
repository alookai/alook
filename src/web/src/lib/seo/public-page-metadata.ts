import type { Metadata } from "next";
import { SITE_OG_IMAGE, SITE_OG_IMAGE_URL, SITE_URL } from "./site-metadata";

type PublicPageMetadata = {
  title: string;
  description: string;
  path: `/${string}`;
  alternateTypes?: NonNullable<Metadata["alternates"]>["types"];
};

export function buildPublicPageMetadata({
  title,
  description,
  path,
  alternateTypes,
}: PublicPageMetadata): Metadata {
  const url = path === "/" ? SITE_URL : new URL(path, SITE_URL).toString();

  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url, ...(alternateTypes && { types: alternateTypes }) },
    openGraph: {
      type: "website",
      siteName: "Alook",
      title,
      description,
      url,
      images: [SITE_OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      site: "@alook_ai",
      title,
      description,
      images: [SITE_OG_IMAGE_URL],
    },
  };
}
