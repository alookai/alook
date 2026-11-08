"use client";

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      <span className="size-1 rounded-full bg-muted-foreground/60 motion-safe:animate-[typing-dot_1.2s_ease-in-out_infinite]" />
      <span className="size-1 rounded-full bg-muted-foreground/60 motion-safe:animate-[typing-dot_1.2s_ease-in-out_0.2s_infinite]" />
      <span className="size-1 rounded-full bg-muted-foreground/60 motion-safe:animate-[typing-dot_1.2s_ease-in-out_0.4s_infinite]" />
    </span>
  );
}

export function PresenceLine({ agentFirstName }: { agentFirstName: string }) {
  return (
    <div className="h-5 px-1 mb-2 flex items-center" aria-live="polite">
      <span className="inline-flex items-center gap-2 text-sm text-muted-foreground motion-safe:animate-[fade-up_200ms_ease-out_both]">
        <span>{agentFirstName} is typing</span>
        <TypingDots />
      </span>
    </div>
  );
}
