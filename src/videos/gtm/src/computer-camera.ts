// Full laptop bounds: x=200..1720, y=65..777.
export const wideComputerCamera = [960, 421, 1.16] as const;

export function computerCameraTransform(x: number, y: number, zoom: number) {
  // Center the entire device in wide shots, then retain the established
  // closeup aim and subtitle clearance as the camera moves into the screen.
  const closeup = Math.max(0, Math.min(1, (zoom - 1.16) / (1.6 - 1.16)));
  const aimY = 540 - 70 * closeup;
  return `translate(${960 - x * zoom}px,${aimY - y * zoom}px) scale(${zoom})`;
}
