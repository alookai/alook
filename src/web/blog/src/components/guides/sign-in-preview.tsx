"use client"

import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldSeparator } from "@/components/ui/field"
import { CommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation"
import { SignInEmailField } from "@/app/(auth)/sign-in/sign-in-fields"
import { SignInGallery, SignInHeading, SignInLayout } from "@/app/(auth)/sign-in/sign-in-presentation"
import { SignInTermsControl } from "@/app/(auth)/sign-in/sign-in-terms-control"
import { SocialSignInButtons } from "@/app/(auth)/sign-in/social-sign-in-buttons"

const ignore = () => {}

export function SignInPreview() {
  return <figure aria-label="Alook sign-in screen" className="relative isolate mt-6 overflow-hidden rounded-xl" data-sign-in-preview>
    <div inert aria-hidden="true">
      <CommunityPreviewNavigation value={true}>
        <SignInLayout embedded className="min-h-0" gallery={<SignInGallery beat={0} />}>
          <FieldGroup>
            <SignInHeading headingAs="div" subtitle="Enter your email — we’ll send you a verification code" />
            <form noValidate onSubmit={event => event.preventDefault()}>
              <FieldGroup>
                <SignInEmailField email="" onChange={ignore} autoFocus={false} />
                <Field><Button variant="outline" size="lg" type="button" className="w-full text-base">Send Code</Button></Field>
              </FieldGroup>
            </form>
            <SignInTermsControl id="tutorial-sign-in-terms" />
            <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">Or continue with</FieldSeparator>
            <SocialSignInButtons appleEnabled />
          </FieldGroup>
        </SignInLayout>
      </CommunityPreviewNavigation>
    </div>
  </figure>
}
