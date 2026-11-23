import { useEffect, useId } from "react";

const workspaceImage = "/landing/typewriter-workspace.webp";

export function TypewriterWorkspaceArt({ onSettled }: { onSettled?: () => void }) {
  const clipId = useId();

  useEffect(() => {
    if (!onSettled) return;
    let active = true;
    const image = new Image();
    image.src = workspaceImage;
    const finish = () => { if (active) onSettled(); };
    void image.decode().then(finish, finish);
    return () => { active = false; };
  }, [onSettled]);

  return (
    <svg
      className="block h-auto w-full select-none"
      viewBox="0 7.3 400 225"
      role="img"
      aria-label="Alook workspace with two people and two bots chatting in the same channel"
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <rect x="10" y="12" width="380" height="201" rx="9" />
        </clipPath>
      </defs>
      <rect x="10" y="12" width="380" height="201" rx="9" fill="var(--tw-paper)" />
      <image
        href={workspaceImage}
        x="10"
        y="12"
        width="380"
        height="201"
        clipPath={`url(#${clipId})`}
      />
      <rect x="10" y="12" width="380" height="201" rx="9" fill="none" stroke="var(--tw-body-lo)" strokeWidth="0.7" />
    </svg>
  );
}
