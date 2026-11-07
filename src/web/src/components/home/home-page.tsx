"use client";

import { useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useHomePetSettings } from "@/lib/home-pet-settings";
import type { CloudCodeMonsterPetProps } from "@/components/home-pet/cloud-code-monster-pet";
import { HeroSection } from "./hero-section";
import { FeatureShowcase } from "./feature-showcase";
import { ArchitectureOverview } from "./architecture-overview";
import { MarketingNav } from "./marketing-nav";
import { MarketingFooter } from "./marketing-footer";
import { ByoaSection } from "./byoa-section";
import { UseCasesSection } from "./use-cases-section";
import { QuickstartSection } from "./quickstart-section";

const CloudCodeMonsterPet = dynamic<CloudCodeMonsterPetProps>(
  () =>
    import("@/components/home-pet/cloud-code-monster-pet").then(
      (module) => module.CloudCodeMonsterPet
    ),
  { ssr: false }
);

gsap.registerPlugin(useGSAP, ScrollTrigger);

export function HomePage({ isLoggedIn }: { isLoggedIn: boolean }) {
  const mainRef = useRef<HTMLDivElement>(null);
  const petSettings = useHomePetSettings();

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    if (prefersReducedMotion) {
      gsap.globalTimeline.timeScale(20);
    }
  }, []);

  useGSAP(
    () => {

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
      <UseCasesSection />
      <FeatureShowcase />
      <ByoaSection />
      <QuickstartSection />
      <ArchitectureOverview />
      <MarketingFooter />
      {isLoggedIn && petSettings.enabled ? (
        <CloudCodeMonsterPet boundaryRef={mainRef} />
      ) : null}
    </div>
  );
}
