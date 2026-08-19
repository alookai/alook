export const ALOOK_ORGANIZATION_ID = "https://alook.ai/#organization";

export const ALOOK_ORGANIZATION = {
  "@type": "Organization",
  "@id": ALOOK_ORGANIZATION_ID,
  name: "Alook AI",
  url: "https://alook.ai",
  logo: "https://alook.ai/alook.svg",
  contactPoint: {
    "@type": "ContactPoint",
    email: "support@alook.ai",
    contactType: "customer support",
  },
} as const;
