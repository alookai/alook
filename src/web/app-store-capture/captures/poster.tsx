import type { CSSProperties } from "react"
import "./poster.css"

function Surface({ scene = "workspace", width, height, viewport = [1280, 800], beat = 9 }: { scene?: string; width: number; height: number; viewport?: [number, number]; beat?: number }) {
  const [logicalWidth, logicalHeight] = viewport
  const scale = Math.min(width / logicalWidth, height / logicalHeight)
  return <div className="surface-frame" style={{ width, height }} data-surface-frame={scene}>
    <iframe title={`Alook ${scene}`} src={`/surface?scene=${scene}&beat=${beat}`} width={logicalWidth} height={logicalHeight} data-logical-width={logicalWidth} data-logical-height={logicalHeight}
      style={{ width: logicalWidth, height: logicalHeight, left: (width - logicalWidth * scale) / 2, top: (height - logicalHeight * scale) / 2, transform: `scale(${scale})` }} />
  </div>
}

function Face({ color, className }: { color: string; className: string }) {
  return <img className={className} src={`/faces/face-${color}.svg`} alt="" />
}

const stories = [
  { kind: "hero", lines: ["Multi-Agent", "Collaboration"], subtitle: <>for Team and Friends</> },
  { kind: "team", lines: ["LET TEAMMATES", "TALK TO YOUR", "AGENT."], subtitle: <>Coordinate multi-agent workflows<br />in one conversation.</> },
  { kind: "companion", lines: ["A COMPANION", "OF YOUR", "OWN."], subtitle: <>Your agent belongs to you.<br />Bring them along to any room or team you join.</> },
  { kind: "continuity", lines: ["PICK UP", "WHERE YOU", "LEFT OFF."], subtitle: <>Keep the context</> },
  { kind: "reach", lines: ["CHECK IN", "FROM YOUR", "PHONE."], subtitle: <>Read updates and give the next instruction<br />wherever you are.</> },
  { kind: "setup", lines: ["KEEP YOUR", "EXISTING", "SETUP."], subtitle: <>Connect the agent you already use.</> },
]

function Mobile({ width }: { width: number }) {
  return <Surface width={width} height={width * 874 / 402} viewport={[402, 874]} />
}

function PhonePoster({ story, large = false }: { story: number; large?: boolean }) {
  const data = stories[story - 1]
  return <section className={`poster phone-poster ${data.kind}`} data-story={story} style={large ? { transform: `scale(${1320 / 1206})`, transformOrigin: "top left" } : undefined}>
    <div className="phone-story-content">
    <h1 className="headline">{data.lines.map((line, index) => <span key={line}>{index > 0 && <br />}<span className={index === data.lines.length - 1 ? "accent" : undefined}>{line}</span></span>)}</h1>
    <p className="subtitle">{data.subtitle}</p>
    {story === 1 && <>
      <div className="phone"><Mobile width={926} /></div>
      <div className="reply"><Surface scene="reply" width={1079} height={278} viewport={[500, 130]} /></div>
      <Face color="blue" className="art-face hero-blue" /><Face color="orange" className="art-face hero-orange" />
    </>}
    {story === 2 && <>
      <div className="window"><Surface width={1076} height={674} /></div>
      <div className="quote-card team-quote"><Surface scene="reply" width={1055} height={352} viewport={[450, 150]} /></div>
      <Face color="teal" className="art-face team-teal" /><Face color="purple" className="art-face team-purple" /><Face color="orange" className="art-face team-orange" />
    </>}
    {story === 3 && <>
      <div className="window"><Surface scene="identity" beat={14} width={1174} height={692} viewport={[1120, 660]} /></div>
      <div className="profile"><Surface scene="profile" width={872} height={895.25} viewport={[300, 308]} /></div>
      <div className="chip">Invite your agent</div>
      <Face color="purple" className="art-face companion-purple" /><Face color="blue" className="art-face companion-blue" />
    </>}
    {story === 4 && <>
      <div className="window"><Surface scene="continuity" beat={9} width={1154} height={688} viewport={[1120, 660]} /></div>
      <div className="quote-card continuity-ask"><Surface scene="continuity-ask" width={1030} height={270} viewport={[500, 130]} /></div>
      <div className="quote-card continuity-answer"><Surface scene="continuity-answer" width={1000} height={220} viewport={[500, 110]} /></div>
      <Face color="red" className="art-face continuity-red" /><Face color="blue" className="art-face continuity-blue" />
    </>}
    {story === 5 && <>
      <div className="phone"><Mobile width={926} /></div>
      <div className="composer-focus"><div className="composer-crop"><Surface scene="composer" width={1089} height={174} viewport={[402, 64]} /></div></div>
      <Face color="teal" className="art-face reach-teal" /><Face color="red" className="art-face reach-red" />
      <div className="chip">Keep your agent’s computer online.</div>
    </>}
    {story === 6 && <>
      <div className="desktop-device"><div className="desktop-screen"><Surface width={1332} height={832} /></div><div className="monitor-neck" /><div className="monitor-base" /></div>
      <div className="mobile-device"><Mobile width={436} /></div>
      {["red", "purple", "teal", "blue", "orange"].map(color => <Face key={color} color={color} className={`scattered-face face-${color}`} />)}
    </>}
    </div>
  </section>
}

function StoryHeading({ story, tablet = false }: { story: number; tablet?: boolean }) {
  const data = stories[story - 1]
  const lines = tablet ? [
    ["Multi-Agent Collaboration"], ["LET TEAMMATES TALK", "TO YOUR AGENT."], ["A COMPANION", "OF YOUR OWN."],
    ["PICK UP WHERE", "YOU LEFT OFF."], ["CHECK IN FROM", "YOUR IPAD."], ["KEEP YOUR", "EXISTING SETUP."],
  ][story - 1] : story === 5 ? ["CHECK IN", "ON THE", "GO."] : data.lines
  return <>
    <h1 className="headline">{lines.map((line, index) => <span key={line} className={lines.length > 1 && index === lines.length - 1 ? "accent" : undefined}>{lines.length === 1 ? <>{line.slice(0, line.lastIndexOf(" ") + 1)}<span className="accent">{line.slice(line.lastIndexOf(" ") + 1)}</span></> : line}</span>)}</h1>
    <p className="subtitle">{data.subtitle}</p>
  </>
}

function TabletPoster({ story }: { story: number }) {
  const data = stories[story - 1]
  const scene = story === 3 ? "identity" : story === 4 ? "continuity" : "workspace"
  return <section className={`tablet-poster ${data.kind}`} data-story={story}>
    <StoryHeading story={story} tablet />
    <div className="tablet-window"><Surface scene={scene} beat={story === 3 ? 14 : 9} width={2032} height={1270} viewport={scene === "workspace" ? [1280, 800] : [1120, 660]} /></div>
    {(story === 1 || story === 2) && <div className="tablet-detail tablet-reply"><Surface scene="reply" width={1640} height={360} viewport={[600, 130]} /></div>}
    {story === 3 && <div className="tablet-detail tablet-profile"><Surface scene="profile" width={750} height={770} viewport={[300, 308]} /></div>}
    {story === 4 && <>
      <div className="tablet-detail tablet-ask"><Surface scene="continuity-ask" width={1320} height={350} viewport={[500, 130]} /></div>
      <div className="tablet-detail tablet-answer"><Surface scene="continuity-answer" width={1260} height={280} viewport={[500, 110]} /></div>
    </>}
    {story === 5 && <div className="tablet-detail tablet-composer"><Surface scene="composer" width={1840} height={240} viewport={[700, 90]} /></div>}
    {story === 6 && <div className="tablet-detail tablet-setup"><Surface scene="provider" width={1008} height={594} viewport={[1120, 660]} /></div>}
    <Face color={story === 3 ? "purple" : "orange"} className="art-face tablet-left" />
    <Face color={story === 4 ? "red" : "teal"} className="art-face tablet-right" />
  </section>
}

function DuoDevice({ form, scene = "workspace", beat = 9 }: { form: "unfolded" | "folded"; scene?: string; beat?: number }) {
  const open = form === "unfolded"
  const viewport: [number, number] = open ? scene === "workspace" ? [951, 669] : [1120, 660] : scene === "profile" ? [300, 437] : [466, 678]
  return <div className={`device ${form}`}>
    <div className="screen"><Surface scene={scene} beat={beat} width={open ? 1618 : 790.406} height={open ? 1138.05 : 1150} viewport={viewport} /></div>
    {open && <><div className="hinge-top" /><div className="hinge-bottom" /></>}
  </div>
}

function DuoPoster({ story }: { story: number }) {
  const data = stories[story - 1]
  return <section className={`duo-poster ${data.kind}`} data-story={story}>
    <StoryHeading story={story} />
    {story !== 5 && <DuoDevice form="unfolded" scene={story === 3 ? "identity" : story === 4 ? "continuity" : "workspace"} beat={story === 3 ? 14 : 9} />}
    {(story === 3 || story === 5 || story === 6) && <DuoDevice form="folded" scene={story === 3 ? "profile" : "workspace"} />}
    {(story === 1 || story === 2) && <div className="duo-detail duo-reply"><Surface scene="reply" width={1620} height={400} viewport={[550, 130]} /></div>}
    {story === 4 && <>
      <div className="duo-detail duo-ask"><Surface scene="continuity-ask" width={1600} height={420} viewport={[500, 130]} /></div>
      <div className="duo-detail duo-answer"><Surface scene="continuity-answer" width={1510} height={335} viewport={[500, 110]} /></div>
    </>}
    {story === 5 && <div className="duo-detail duo-composer"><Surface scene="composer" width={1570} height={260} viewport={[600, 100]} /></div>}
    {["purple", "teal", "orange", "blue", "red"].map(color => <Face key={color} color={color} className={`face ${color}`} />)}
  </section>
}

export function Artwork({ kind, story, large }: { kind: string; story: number; large: boolean }) {
  const dimensions = kind === "duo" ? [2007, 2853] : kind === "tablet" ? [2752, 2064] : large ? [1320, 2868] : [1206, 2622]
  return <div id="capture-poster" className="capture-canvas" style={{ width: dimensions[0], height: dimensions[1] } as CSSProperties}>
    {kind === "duo" ? <DuoPoster story={story} /> : kind === "tablet" ? <TabletPoster story={story} /> : <PhonePoster story={story} large={large} />}
  </div>
}
