import { useEffect, useId } from "react";

const workspaceImages = {
  light: "/landing/typewriter-workspace.webp",
  dark: "/landing/typewriter-workspace-dark.webp",
};
const frame = { x: 10, y: 12, width: 380, height: 201 };

export function TypewriterWorkspaceArt({ onSettled }: { onSettled?: () => void }) {
  const clipId = useId();

  useEffect(() => {
    if (!onSettled) return;
    let active = true;
    const image = new Image();
    image.src = document.documentElement.classList.contains("dark")
      ? workspaceImages.dark
      : workspaceImages.light;
    const finish = () => { if (active) onSettled(); };
    void image.decode().then(finish, finish);
    return () => { active = false; };
  }, [onSettled]);

  return (
    <svg
      className="block h-auto w-full select-none"
      viewBox="7 9.2 386 213"
      role="img"
      aria-label="Alook workspace with two people and two bots chatting in the same channel"
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <rect {...frame} rx="9" />
        </clipPath>
      </defs>
      <rect {...frame} rx="9" fill="var(--tw-paper)" />
      <g clipPath={`url(#${clipId})`}>
        <image {...frame} href={workspaceImages.light} className="dark:hidden" />
        <image {...frame} href={workspaceImages.dark} className="hidden dark:block" />
      </g>
      <rect {...frame} rx="9" fill="none" stroke="var(--tw-body-lo)" strokeWidth="0.7" />
    </svg>
  );
}
