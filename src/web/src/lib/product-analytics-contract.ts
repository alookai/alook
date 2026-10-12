export const LANDING_CTA_NAMES = [
  "open_app", "get_started", "templates", "public_nav_open_app", "public_nav_get_started",
  "pricing_open_app", "pricing_get_started", "templates_open_app", "templates_get_started", "closing_open_app", "closing_get_started",
  ...["product", "identity", "continuity", "reach", "ownership"].flatMap(section => [`${section}_open_app`, `${section}_get_started`]),
] as const
