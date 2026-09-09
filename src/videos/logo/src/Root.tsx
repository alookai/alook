import "./index.css";
import { Composition, Still } from "remotion";
import { AlookLogoAnimation, AlookLogoReference } from "./Composition";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="AlookLogoAlpha"
        component={AlookLogoAnimation}
        durationInFrames={300}
        fps={60}
        width={1080}
        height={1080}
        defaultProps={{ background: "transparent" }}
      />
      <Composition
        id="AlookLogoPreview"
        component={AlookLogoAnimation}
        durationInFrames={300}
        fps={60}
        width={1080}
        height={1080}
        defaultProps={{ background: "dark" }}
      />
      <Still
        id="AlookLogoReference"
        component={AlookLogoReference}
        width={1080}
        height={1080}
      />
    </>
  );
};
