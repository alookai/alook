"use client"

import { Avatar } from "@/components/community/avatar"
import { ServerIcon } from "@/components/community/server-icon"
import { Button } from "@/components/ui/button"

export function CollaborationCapture() {
  return (
    <>
      <section id="capture-collaboration" className="feature-canvas collaboration-canvas">
        <div className="flex size-full flex-col items-center justify-center bg-background px-6 text-center">
          <div className="collaboration-content flex w-full max-w-sm flex-col items-center">
            <ServerIcon
              id="home"
              name="Home"
              initial="H"
              icon={null}
              size={84}
              className="rounded-2xl"
            />
            <p className="mt-5 text-xs font-medium text-muted-foreground">You&apos;re invited to join</p>
            <h1 className="mt-1 font-brand text-4xl leading-tight font-bold">Home</h1>
            <div className="mt-4 flex items-center gap-1.5 text-sm text-muted-foreground">
              <span>Invited by</span>
              <Avatar label="Maya" seed="maya" size={20} />
              <span className="font-medium text-foreground">Maya</span>
            </div>
            <Button className="mt-6 h-11 w-full rounded-xl text-base">Join server</Button>
            <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
              <div className="flex items-center -space-x-1.5">
                <Avatar label="Maya" seed="maya" size={20} ringColor="var(--background)" />
                <Avatar label="Alli" seed="alli" size={20} ringColor="var(--background)" />
                <Avatar label="Gus" seed="gus" size={20} ringColor="var(--background)" />
              </div>
              <span>3 members</span>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">Free to join · leave anytime</p>
          </div>
        </div>
      </section>

      <style jsx global>{`
        .collaboration-content {
          transform: scale(1.9941);
        }
      `}</style>
    </>
  )
}
