"use client";

import type { MouseEvent } from "react";
import { ZoneLink } from "@/components/public-layout";
import { trackLandingCtaClicked } from "@/lib/analytics";

export type BlogCtaName =
  | "blog_topbar_get_started"
  | "blog_sidebar_get_started"
  | "blog_mid_get_started"
  | "blog_end_get_started"
  | "blog_end_use_cases";

export function BlogCtaLink({
  href,
  ctaName,
  className,
  onClick,
  children,
  ...props
}: Omit<React.ComponentPropsWithoutRef<"a">, "href"> & {
  href: string;
  ctaName: BlogCtaName;
}) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    trackLandingCtaClicked({ cta_name: ctaName }, event);
    onClick?.(event);
  };

  return (
    <ZoneLink {...props} href={href} zone="blog" className={className} onClick={handleClick}>
      {children}
    </ZoneLink>
  );
}
