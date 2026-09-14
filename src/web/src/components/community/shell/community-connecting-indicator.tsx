"use client"

import { AlookLoading } from "@/components/brand/alook-loading/AlookLoading"

const CONNECTING_LABEL = "Connecting…"

export function CommunityConnectingIndicator({ titleId }: { titleId?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-slot="text-loader"
      data-variant="default"
      className="community-ws-connecting-loader"
    >
      {/* Adapted from OpensourceUI's TextLoader. See ../../home/opensourceui-mockups.LICENSE.txt. */}
      <div aria-hidden="true" data-connecting-motion="" className="flex h-36 w-44 items-center justify-center sm:h-40 sm:w-48">
        <AlookLoading size={192} className="scale-90 sm:scale-100" />
      </div>
      <h2
        id={titleId}
        aria-label={CONNECTING_LABEL}
        className="community-ws-connecting-text justify-center font-heading text-base font-medium"
      >
        {CONNECTING_LABEL.split("").map((letter, index) => (
          <span
            key={`${letter}-${index}`}
            aria-hidden="true"
            className="community-ws-connecting-letter"
            style={{ animationDelay: `${index * 0.09}s` }}
          >
            {letter}
          </span>
        ))}
      </h2>
    </div>
  )
}
