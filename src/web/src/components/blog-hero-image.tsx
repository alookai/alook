"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

interface BlogHeroImageProps {
  imageVariantA: string;
  imageVariantB: string;
  imageAlt: string;
  title: string;
}

export function BlogHeroImage({
  imageVariantA,
  imageVariantB,
  imageAlt,
  title,
}: BlogHeroImageProps) {
  const [selectedVariant, setSelectedVariant] = useState<"A" | "B">("A");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Initialize A/B test variant
    const storedVariant = localStorage.getItem("blog-hero-variant");

    if (storedVariant === "A" || storedVariant === "B") {
      setSelectedVariant(storedVariant);
    } else {
      // Randomly assign variant for new visitors
      const variant = Math.random() < 0.5 ? "A" : "B";
      setSelectedVariant(variant);
      localStorage.setItem("blog-hero-variant", variant);
    }

    // Track variant selection in analytics
    if (typeof window !== "undefined" && window.gtag) {
      window.gtag("event", "blog_hero_variant", {
        event_category: "A/B Test",
        event_label: title,
        variant: selectedVariant,
      });
    }
  }, [title, selectedVariant]);

  const imageSrc = selectedVariant === "A" ? imageVariantA : imageVariantB;

  return (
    <div className="relative w-full h-[400px] md:h-[500px] lg:h-[600px] mb-12 -mx-6 sm:-mx-0">
      <Image
        src={imageSrc}
        alt={imageAlt}
        fill
        priority
        className={`object-cover rounded-lg transition-opacity duration-500 ${
          isLoading ? "opacity-0" : "opacity-100"
        }`}
        onLoad={() => setIsLoading(false)}
        sizes="(max-width: 768px) 100vw, (max-width: 1200px) 80vw, 1200px"
      />
      {/* WebP fallback handled by Next.js Image component automatically */}

      {/* Loading skeleton */}
      {isLoading && (
        <div className="absolute inset-0 bg-gradient-to-br from-[#1a1a2e] to-[#b0b0ff] animate-pulse rounded-lg" />
      )}
    </div>
  );
}