"use client";

import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { HeroSection } from "./hero-section";
import { FeatureShowcase } from "./feature-showcase";
import { ArchitectureOverview } from "./architecture-overview";
import { MarketingNav } from "./marketing-nav";
import { MarketingFooter } from "./marketing-footer";
import { ByoaSection } from "./byoa-section";
import { QuickstartSection } from "./quickstart-section";

gsap.registerPlugin(useGSAP, ScrollTrigger);

// Respect reduced motion preference
if (typeof window !== "undefined") {
  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;
  if (prefersReducedMotion) {
    gsap.globalTimeline.timeScale(20); // effectively skip animations
  }
}

export function HomePage({ isLoggedIn }: { isLoggedIn: boolean }) {
  const mainRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      // Floating nav fades in when hero section unpins
      ScrollTrigger.create({
        trigger: ".hero-section",
        start: "bottom top",
        onEnterBack: () => {
          gsap.to(".marketing-nav", {
            autoAlpha: 0,
            duration: 0.3,
            ease: "power2.out",
          });
        },
        onLeave: () => {
          gsap.to(".marketing-nav", {
            autoAlpha: 1,
            duration: 0.3,
            ease: "power2.out",
          });
        },
      });
    },
    { scope: mainRef }
  );

  return (
    <div
      ref={mainRef}
      className="landing relative flex-1 overflow-x-clip"
      style={{ backgroundColor: "var(--landing-bg)" }}
    >
      <MarketingNav isLoggedIn={isLoggedIn} />
      <HeroSection isLoggedIn={isLoggedIn} />
      <ByoaSection />
      <FeatureShowcase />
      <QuickstartSection />
      <ArchitectureOverview />
      <MarketingFooter />
    </div>
  );
}
