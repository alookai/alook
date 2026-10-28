"use client"

import type { NativeOauthProvider } from "@alook/shared"
import { SiGithub, SiGoogle } from "@icons-pack/react-simple-icons"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { APPLE_LEFT_ALIGNED_LOGO_BLACK, APPLE_LEFT_ALIGNED_LOGO_WHITE } from "./apple-sign-in-artwork"

export function SocialSignInButtons({ appleEnabled = false, disabled = false, appleDisabled = false, onProvider }: { appleEnabled?: boolean; disabled?: boolean; appleDisabled?: boolean; onProvider?: (provider: NativeOauthProvider) => void }) {
  return (
      <Field className="grid grid-cols-2 gap-4">
        <Button
          size="lg"
          type="button"
          disabled={disabled}
          className="border-0 bg-apple-signin text-base text-apple-signin-foreground hover:bg-apple-signin"
          data-testid="native-oauth-github"
          onClick={() => onProvider?.("github")}
        >
          <span className="inline-flex items-center gap-2" data-testid="native-oauth-github-content">
            <SiGithub className="size-4" aria-hidden />
            <span>GitHub</span>
          </span>
        </Button>
        <Button
          size="lg"
          type="button"
          disabled={disabled}
          className="border-0 bg-apple-signin text-base text-apple-signin-foreground hover:bg-apple-signin"
          data-testid="native-oauth-google"
          onClick={() => onProvider?.("google")}
        >
          <span className="inline-flex items-center gap-2" data-testid="native-oauth-google-content">
            <SiGoogle className="size-4" aria-hidden />
            <span>Google</span>
          </span>
        </Button>
        {appleEnabled ? (
          <Button
            type="button"
            size="lg"
            disabled={disabled || appleDisabled}
            className="col-span-2 min-w-35 border-0 bg-apple-signin text-base text-apple-signin-foreground hover:bg-apple-signin"
            data-testid="native-oauth-apple"
            onClick={() => onProvider?.("apple")}
          >
            <span className="inline-flex items-center gap-2" data-testid="native-oauth-apple-content">
              <span className="grid h-9 place-items-center" aria-hidden>
                <Image
                  src={APPLE_LEFT_ALIGNED_LOGO_WHITE}
                  alt=""
                  width={31}
                  height={44}
                  unoptimized
                  className="col-start-1 row-start-1 h-9 w-auto dark:hidden"
                  data-testid="apple-official-left-aligned-logo-white"
                />
                <Image
                  src={APPLE_LEFT_ALIGNED_LOGO_BLACK}
                  alt=""
                  width={31}
                  height={44}
                  unoptimized
                  className="col-start-1 row-start-1 hidden h-9 w-auto dark:block"
                  data-testid="apple-official-left-aligned-logo-black"
                />
              </span>
              <span>Continue with Apple</span>
            </span>
          </Button>
        ) : null}
      </Field>
  )
}
