"use client";

interface AnimatedStepProps {
  step: number;
  currentStep: number;
  isResetting: boolean;
  showAll: boolean;
  children: React.ReactNode;
}

export function AnimatedStep({
  step,
  currentStep,
  isResetting,
  showAll,
  children,
}: AnimatedStepProps) {
  if (showAll) {
    return <div>{children}</div>;
  }

  const isVisible = !isResetting && currentStep >= step;

  return (
    <div
      style={{
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? "translateY(0)" : "translateY(4px)",
        transition: isResetting
          ? "opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1)"
          : "opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1), transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
      }}
    >
      {children}
    </div>
  );
}
