"use client";

import { legacyTweenTimeScale } from "./legacy-tween-time-scale";

import { useRef } from "react";
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


  useGSAP(
    () => {
      const hero = mainRef.current?.querySelector<HTMLElement>(".hero-section");
      const nav = mainRef.current?.querySelector<HTMLElement>(".marketing-nav");
      if (!hero || !nav) return;
      const timeScale = legacyTweenTimeScale();
      let navTween: gsap.core.Tween | undefined;
      const reveal = (autoAlpha: number) => {
        navTween?.kill();
        navTween = gsap.to(nav, { autoAlpha, duration: 0.3, ease: "power2.out" }).timeScale(timeScale);
      };
      ScrollTrigger.create({
        trigger: hero,
        start: "bottom top",
        onEnterBack: () => reveal(0),
        onLeave: () => reveal(1),
      });
      return () => navTween?.kill();
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
