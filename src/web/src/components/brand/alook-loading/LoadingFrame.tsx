import { artworkByFace, type FaceKind } from "./BotArtwork";
import { motionAt, smooth } from "./motion";
const bots: {
  face: FaceKind;
  x: number;
  y: number;
  scale: number;
  tilt: number;
}[] = [
  { face: "red", x: -100, y: -45, scale: 0.8, tilt: 8 },
  { face: "purple", x: -20, y: -55, scale: 0.78, tilt: -9 },
  { face: "teal", x: -200, y: 20, scale: 0.76, tilt: -7 },
  { face: "blue", x: -85, y: 0, scale: 0.77, tilt: 7 },
  { face: "orange", x: 55, y: 130, scale: 0.76, tilt: -5 },
];
export const LoadingFrame = ({ frame }: { frame: number }) => {
  const { joined, orbit, look } = motionAt(frame);
  const drawBot = (bot: (typeof bots)[number], index: number) => (
    <div
      key={bot.face}
      style={{
        position: "absolute",
        inset: 0,
        width: 660,
        height: 660,
        translate: `${bot.x * 0.96 * (1 - joined)}px ${bot.y * 0.96 * (1 - joined)}px`,
        scale: bot.scale + (1 - bot.scale) * joined,
        zIndex: index + 1,
      }}
    >
      <div style={{ width: 660, height: 660, rotate: `${look * bot.tilt}deg` }}>
        {artworkByFace[bot.face](
          bot.face === "orange" ? 1 : 1 - smooth((joined - 0.45) / 0.55),
          look * 16,
        )}
      </div>
    </div>
  );
  return (
    <div style={{ position: "absolute", width: 1080, height: 1080 }}>
      <div
        style={{
          position: "absolute",
          width: 660,
          height: 660,
          left: "50%",
          top: "50%",
          marginLeft: -330,
          marginTop: -330,
          clipPath: `inset(${-300 * (1 - joined)}px round ${152.109375 * joined}px)`,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            width: 660,
            height: 660,
            rotate: `${orbit}deg`,
          }}
        >
          {bots.slice(0, 4).map(drawBot)}
        </div>
        {drawBot(bots[4], 4)}
      </div>
    </div>
  );
};
