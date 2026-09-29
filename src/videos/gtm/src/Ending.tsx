import React from "react";
import { Img, staticFile, interpolate, Easing } from "remotion";
import { GeneratedAvatar, seed } from "./Product";
const p = (t: number, a: number, b: number) =>
  interpolate(t, [a, b], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.65, 0, 0.2, 1),
  });
const lerp = (a: number, b: number, v: number) => a + (b - a) * v;
const Bot = ({ name, size }: { name: string; size: number }) => (
  <div className="bot-avatar" style={{ width: size, height: size }}>
    <GeneratedAvatar seed={seed(name)} size={size} />
  </div>
);
const roles = [
  "Page",
  "Copy",
  "Research",
  "Design",
  "Week planning",
  "Travel",
  "Spanish",
  "Notes",
  "Code review",
];
const agents = [
  "Milo",
  "Nova",
  "Remy",
  "Pip",
  "June",
  "Atlas",
  "Sol",
  "Kit",
  "Ada",
];
export function Constellation({ t }: { t: number }) {
  const arrival = p(t, 73.5, 75),
    expand = p(t, 77.5, 80),
    merge = p(t, 81.5, 84);
  const positions = [
    [0, 0],
    [-360, -110],
    [360, -110],
    [-650, 90],
    [650, 90],
    [-440, 310],
    [440, 310],
    [-155, 285],
    [155, 285],
  ];
  return (
    <>
      {t >= 73.5 && t < 84.1 && (
        <div
          className="constellation"
          style={{ transform: `translateY(${(1 - arrival) * 800}px)` }}
        >
          <div
            className="next-time"
            style={{ transform: `translateX(${-p(t, 77, 78) * 2000}px)` }}
          >
            <Img
              src={staticFile("people/Alex.png")}
              style={{ width: 50, height: 50, borderRadius: "50%" }}
            />
            <b>Alex</b>
            <span>Next time, I’ll just ask Milo.</span>
          </div>
          <svg width="1920" height="1000" className="constellation-lines">
            {positions.map(([x, y], i) => (
              <path
                key={i}
                d={`M 960 800 Q ${960 + x * 0.7} ${600 + y * 0.2} ${960 + x} ${375 + y}`}
                fill="none"
                stroke={i < 2 ? "#dfab64" : "#d6ccc0"}
                strokeWidth={i < 2 ? 4 : 2}
                pathLength="1"
                strokeDasharray="1"
                strokeDashoffset={i === 0 ? 0 : 1 - expand}
              />
            ))}
          </svg>
          {agents.map((name, i) => {
            const [x, y] = positions[i];
            const emerge = i === 0 ? 1 : p(t, 77.3 + i * 0.12, 78.3 + i * 0.12);
            return (
              <div
                key={name}
                className="orbit-agent"
                style={{
                  left: 960 + lerp(x * (i ? expand : 1), 0, merge),
                  top: 375 + lerp(y, 0, merge),
                  transform: `translate(-50%,-50%) scale(${emerge * (1 - merge)})`,
                }}
              >
                <Bot name={name} size={i === 0 ? 152 : i === 1 ? 125 : 90} />
                <b>{name}</b>
                <span>{roles[i]}</span>
              </div>
            );
          })}
          <div
            className="computer-anchor"
            style={{ transform: `translate(-50%,${merge * 700}px)` }}
          >
            ▱ <b>Lin’s computer</b>
            <span>Codex · Claude Code</span>
          </div>
        </div>
      )}
    </>
  );
}
