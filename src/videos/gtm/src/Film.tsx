import React from "react";
import { sourceTimeAt } from "./review-timing";
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  staticFile,
  useCurrentFrame,
  interpolate,
  Easing,
} from "remotion";
import { Product, GeneratedAvatar, ProviderLogo, seed } from "./Product";
import { MacOpening } from "./MacOpening";
import { Constellation } from "./Ending";
import voice from "./voice-timing.json";
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const ease = Easing.bezier(0.55, 0, 0.2, 1);
const p = (t: number, a: number, b: number) =>
  interpolate(t, [a, b], [0, 1], { ...clamp, easing: ease });
const mix = (a: number, b: number, v: number) => a + (b - a) * v;
const person = (name: string) => staticFile(`people/${name}.png`);
import shots from "./camera-keyframes.json";
export function cameraAt(t: number) {
  let i = shots.findIndex((s) => s[0] > t);
  if (i < 0) i = shots.length - 1;
  if (i === 0) i = 1;
  const a = shots[i - 1],
    b = shots[i],
    q = p(t, a[0], b[0]);
  return {
    x: mix(a[1], b[1], q),
    y: mix(a[2], b[2], q),
    z: mix(a[3], b[3], q),
  };
}
function Human({ name, size = 70 }: { name: string; size?: number }) {
  return (
    <Img
      src={person(name)}
      style={{ width: size, height: size, borderRadius: "50%" }}
    />
  );
}
function Draft({ t }: { t: number }) {
  const off = p(t, 11.5, 12.8),
    returning = p(t, 22.9, 23.7),
    exit = p(t, 25.8, 26.6);
  const compact = returning;
  const written = Math.floor(mix(0, 31, p(t, 23.7, 25.2)));
  return (
    <>
      <div className="lin-intro" style={{ left: 150 - off * 1600 - p(t, 1.9, 2.8) * 800, top: 200 }}>
        <Human name="Lin" size={210} />
        <h1>Lin</h1>
        <p>
          Getting his team’s
          <br />
          new website ready to launch.
        </p>
        <div className="human-role">TEAMMATE · SITE OWNER</div>
      </div>
      <div
        className="draft-v2"
        style={{
          left: mix(770 - off * 2400, 80, returning) - exit * 1600,
          top: mix(155, 230, compact),
          width: mix(800, 330, compact),
          height: mix(645, 570, compact),
          padding: mix(52, 26, compact),
          transform: `rotate(${mix(1, -2, compact)}deg)`,
        }}
      >
        <div className="draft-person">
          <Human name="Lin" size={compact > 0.5 ? 44 : 54} />
          <b>Lin’s draft</b>
          <span>{t >= 25 ? "Ready" : "Not finished"}</span>
        </div>
        <h2 style={{ fontSize: mix(67, 43, compact) }}>Launch announcement</h2>
        <p style={{ fontSize: mix(32, 25, compact) }}>
          Today we’re sharing
          <br />
          something we’ve been
          <br />
          working on together.
        </p>
        <div className="draft-edit" style={{ fontSize: mix(32, 23, compact) }}>
          {returning > 0.9
            ? "And it’s ready for you to try.".slice(0, written)
            : "We can’t wait to brin"}
          <i />
        </div>
        <div className="draft-rule" />
        <div className="draft-rule short" />
        {t >= 25 && t < 26.6 && (
          <div className="draft-ready">Ready to share ✓</div>
        )}
      </div>
    </>
  );
}
function Computer({ t }: { t: number }) {
  const connect = p(t, 11.7, 13.1),
    minify = p(t, 17, 18.8),
    exit = p(t, 25.8, 26.5);
  return (
    <div
      className={"computer-v2 " + (minify > 0.9 ? "compact-computer" : "")}
      style={{
        left: mix(mix(2240, 250, connect), 80, minify) - exit * 900,
        top: mix(mix(180, 245, connect), 795, minify),
        width: mix(mix(860, 560, connect), 330, minify),
        height: mix(mix(540, 480, connect), 120, minify),
        borderRadius: mix(28, 20, minify),
      }}
    >
      <div className="computer-owner">
        <Human name="Lin" size={30} />
        <span>Lin’s computer</span>
        <i />
      </div>
      <div className="runtime-name">
        <ProviderLogo provider="codex" className="runtime-logo" />
        <b>Codex</b>
        <span>Running locally</span>
      </div>
      {minify < 0.9 && (
        <>
          <div className="runtime-project">~/fieldnotes/launch-page</div>
          <div className="runtime-prompt">
            {t >= 12.8
              ? "Working on Fieldnotes."
              : t < 6.2
                ? "Working on the launch page…"
                : "Move the sign-up button higher."}
          </div>
          <div
            className="runtime-answer"
            style={{
              transform: `translateY(${(1 - p(t, 7.2, 7.6)) * 22}px)`,
              clipPath: `inset(0 0 ${100 * (1 - p(t, 7.2, 7.6))}% 0)`,
            }}
          >
            {t < 12.8 ? (
              <>
                Above the headline
                <br />
                or below?
              </>
            ) : t < 14.3 ? (
              "Local agent, ready."
            ) : (
              "Connected to Alook."
            )}
          </div>
          {t > 13 && (
            <div className="supported-tools">
              <ProviderLogo provider="claude" className="runtime-logo" />
              <span>Claude Code works here, too.</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
function Relay({ t }: { t: number }) {
  const enter = p(t, 4.15, 4.65),
    send = p(t, 5.45, 6.55),
    back = p(t, 8.5, 9.6),
    off = p(t, 11.5, 12.8);
  return (
    <>
      <div
        className="request-v2"
        style={{ left: mix(2070, 1090, enter) - off * 2600, top: 220 }}
      >
        <div className="request-author">
          <Human name="Alex" size={54} />
          <b>Alex</b>
          <span>Lin’s teammate</span>
        </div>
        <p>
          Move the sign-up
          <br />
          button higher.
        </p>
      </div>
      {t >= 5.45 && t < 6.7 && (
        <div
          className="travel-message"
          style={{
            left: mix(1130, 2280, send),
            top: mix(365, 310, send),
            transform: `rotate(${Math.sin(send * Math.PI) * -5}deg) scale(${mix(1, 0.9, send)})`,
          }}
        >
          Move the sign-up button higher.
        </div>
      )}
      {t >= 8.5 && t < 11.8 && (
        <div
          className="return-message"
          style={{
            left: mix(2300, 930, back) - off * 2600,
            top: mix(475, 655, back),
          }}
        >
          <Human name="Lin" size={45} />
          <div>
            <b>Lin → Alex</b>
            <p>Above the headline or below?</p>
          </div>
        </div>
      )}
      {t >= 10.4 && t < 12.8 && (
        <div
          className="another-ping"
          style={{
            left: mix(1990, 1420, p(t, 10.4, 10.8)) - off * 2600,
            top: 545,
          }}
        >
          <Human name="Alex" size={44} />
          <span>One more thing…</span>
        </div>
      )}
    </>
  );
}
function AgentConnection({ t }: { t: number }) {
  const a = p(t, 13.5, 14.3),
    into = p(t, 17.1, 18.4);
  return (
    <>
      {t >= 12 && t < 18.6 && (
        <>
          <svg className="connection-v2" width="1920" height="950">
            <path
              d="M810 455 C960 455 930 400 1080 400"
              fill="none"
              stroke="#ff9915"
              strokeWidth="8"
              pathLength="1"
              strokeDasharray="1"
              strokeDashoffset={1 - a}
            />
          </svg>
          <div
            className="agent-identity-v2"
            style={{
              left: mix(1100, 1080, into),
              top: mix(250, 220, into),
              transform: `scale(${a * (1 - into)})`,
            }}
          >
            <GeneratedAvatar seed={seed("Milo")} size={170} className="rounded-full" />
            <h2>Milo</h2>
            <span>Lin’s agent · Codex</span>
            <div className="identity-alook">
              <Img src={staticFile("alook.svg")} />
              <b>Alook</b>
            </div>
          </div>
        </>
      )}
      {t >= 27 && t < 29.7 && (
        <div
          className="nova-v2"
          style={{
            transform: `translateY(${(1 - p(t, 27, 27.5)) * -700 - p(t, 29, 29.7) * 700}px)`,
          }}
        >
          <div>
            <Human name="Lin" size={45} />
            <span>Lin’s computer</span>
          </div>
          <div>
            <ProviderLogo provider="claude" className="runtime-logo" />
            <b>Claude Code</b>
          </div>
          <span className="nova-arrow">⟶</span>
          <GeneratedAvatar seed={seed("Nova")} size={90} className="rounded-full" />
          <div>
            <b className="nova-name">Nova</b>
            <span>Copy</span>
          </div>
        </div>
      )}
    </>
  );
}
function App({ t }: { t: number }) {
  const enter = p(t, 17.2, 18.6),
    aside = p(t, 22.9, 23.7) - p(t, 26, 26.6),
    dm = p(t, 34.15, 34.9) - p(t, 38.3, 39),
    home = p(t, 42, 42.7),
    leave = p(t, 47.3, 48.3);
  return (
    <div
      className="app-stage app-v2"
      style={{
        left: mix(2100, 280, enter) + aside * 200,
        top: 145 + leave * 1100,
        width: 1200,
        height: 650,
        transform: `scale(${1.12 * (1 - leave * 0.35)})`,
      }}
    >
      <div className="app-frame">
        <div
          style={{
            position: "absolute",
            inset: 0,
            transform: `translateX(${(-dm - home) * 1200}px)`,
          }}
        >
          <Product t={t < 39 ? Math.min(t, 34.15) : t} />
        </div>
        {t >= 34.15 && t < 39 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              transform: `translateX(${(1 - dm) * 1200}px)`,
            }}
          >
            <Product t={t} permission />
          </div>
        )}
        {t >= 42 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              transform: `translateX(${(1 - home) * 1200}px)`,
            }}
          >
            <Product t={t} home />
          </div>
        )}
      </div>
    </div>
  );
}
export function Film({explain = true, narration = true, playbackTime}:{explain?:boolean;narration?:boolean;playbackTime?:number}) {
  const currentTime = useCurrentFrame() / 30;
  const frameTime = playbackTime ?? currentTime;
  const t = sourceTimeAt(frameTime),
    c = cameraAt(t);
  const end = p(t, 55.8, 57);
  const oldEnd = interpolate(
    t,
    [47.3, 48.3, 49.8, 52, 54.7, 57],
    [73.5, 75, 77, 80, 81.5, 84.5],
    clamp,
  );
  const openingCaptions = [
    {from: 0.2, to: 3.15, text: "Alex needs team invites."},
    {from: 3.15, to: 4.5, text: "Lin copies Alex’s request."},
    {from: 4.5, to: 6.85, text: "Then pastes it into Codex."},
    {from: 6.85, to: 11.7, text: "More requests. Copy. Paste. Repeat."},
    {from: 11.7, to: 15.2, text: "Open Alook. Import your local Codex."},
    {from: 15.2, to: 20.8, text: "Same agent. Now on Alook as Milo."},
    {from: 20.8, to: 28.5, text: "Invite Milo and Alex to the same server."},
    {from: 29.2, to: 37.5, text: "Lin introduces Milo to Alex."},
    {from: 37.5, to: 45.5, text: "Alex and Milo can talk directly."},
    {from:51,to:54,text:"Invite more of your bots."},
    {from:54,to:62,text:"Claude Code, OpenCode, Cursor. Together on Alook."},
    {from:62.5,to:72,text:"People and bots, working on the same task."},
    {from:72,to:80,text:"Write, review, build, and test—in one conversation."},
    {from:80,to:84,text:"Ready to share with the team."},
    {from:84,to:89.5,text:"The same Milo is in Home, too."},
    {from:89.5,to:95.4,text:"Lin asks Milo to help plan Mom’s birthday."},
    {from:95.4,to:104,text:"Milo remembers the dinner plans."},
  ];
  const openingCaption = openingCaptions.find(v => t >= v.from && t < v.to);
  const line = voice.find((v) => t >= v.at && t < v.at + v.duration);
  return (
    <AbsoluteFill className="film revision-two">
      <div className="scene-viewport">
        {<MacOpening t={t} />}
        <div
          className="camera-world"
          style={{
            display: "none",
            transform: `translate(${960 - c.x * c.z}px,${470 - c.y * c.z}px) scale(${c.z})`,
          }}
        >
          {t >= 12.8 && <div className="background-orbit one" />}
          {t >= 12.8 && t < 26.6 && <Draft t={t} />} {t >= 12.8 && t < 26.5 && <Computer t={t} />}{" "}

          <AgentConnection t={t} />
          {t >= 17.2 && t < 48.4 && <App t={t} />}
        </div>
        {t >= 84 && t < 57 && <Constellation t={oldEnd} />}
      </div>
      {false && (
        <div
          className="end-card"
          style={{ transform: `translateY(${(1 - end) * -1150}px)` }}
        >
          <Img className="end-logo" src={staticFile("alook.svg")} />
          <div className="end-wordmark">Alook</div>
          <h1>Share your agents with people you trust.</h1>
          <div
            className="cta"
            style={{ transform: `scale(${p(t, 59, 59.55)})` }}
          >
            Start sharing <span>↗</span>
          </div>
          <div className="end-url">alook.ai</div>
        </div>
      )}
      {explain && openingCaption && <div className="caption"><span>{openingCaption.text}</span></div>}
      {line && t >= 84 && t < 55.8 && (
        <div className="caption">
          <span>{line.text}</span>
        </div>
      )}
      {narration && voice.map((v, i) => (
        <Sequence
          key={i}
          from={Math.round(v.at * 30)}
          durationInFrames={Math.ceil(v.duration * 30)}
        >
          <Audio src={staticFile(v.file)} volume={1.25} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
