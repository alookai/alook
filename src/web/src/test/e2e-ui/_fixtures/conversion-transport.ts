import { createStore } from '@tanstack/store'
import { trackPricingCtaClick, trackBeginCheckout, trackPricingView } from '@/lib/analytics'
import { captureProductAnalytics } from '@/lib/product-analytics'
import { bootstrapGoogleAnalytics } from '@/lib/analytics-consent'
import { drainCommunityFunnelEvents } from '@/lib/community/funnel-analytics'

Object.assign(window, { conversionQA: { createStore, captureProductAnalytics, bootstrapGoogleAnalytics, drainCommunityFunnelEvents, trackPricingCtaClick, trackBeginCheckout, trackPricingView } })
