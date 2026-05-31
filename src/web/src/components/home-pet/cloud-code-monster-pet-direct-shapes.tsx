import { getCloudCodeMonsterExpression } from "./cloud-code-monster-pet-activity";
import type {
  CloudCodeMonsterActivityId,
  CloudCodeMonsterPetPreset,
} from "./cloud-code-monster-pet-types";

type DirectPixelEyesProps = {
  activityId: CloudCodeMonsterActivityId | null;
  preset: CloudCodeMonsterPetPreset;
  reacting: boolean;
  shaken: boolean;
  fainted?: boolean;
  eyeOffset?: { x: number; y: number };
  leftX?: number;
  rightX?: number;
  y?: number;
  color?: string;
  highlightColor?: string;
  singleEye?: boolean;
  mouthX?: number;
  mouthY?: number;
  mouthWidth?: number;
  mouthHeight?: number;
  mouthColor?: string;
  mouthStyle?: "flat" | "open" | "smile" | "none";
};

function DirectPixelEyes({
  activityId,
  preset,
  reacting,
  shaken,
  fainted = false,
  eyeOffset = { x: 0, y: 0 },
  leftX = 47,
  rightX = 78,
  y = 43,
  color,
  highlightColor,
  singleEye = false,
  mouthX = 61,
  mouthY,
  mouthWidth = 10,
  mouthHeight = 4,
  mouthColor,
  mouthStyle = "flat",
}: DirectPixelEyesProps) {
  const expression = getCloudCodeMonsterExpression(
    activityId,
    reacting,
    shaken,
    fainted
  );
  const eye = color ?? preset.eye;
  const highlight = highlightColor ?? preset.highlight;
  const faceMouthY = mouthY ?? y + 21;
  const faceMouthColor = mouthColor ?? eye;
  const secondEyeX = singleEye ? null : rightX;
  const renderEyeBlock = (
    eyeX: number,
    eyeY: number,
    width = 8,
    height = 9,
    includeHighlight = true
  ) => (
    <>
      <rect className="cloud-code-monster-pet-eye-blink" x={eyeX} y={eyeY} width={width} height={height} fill={eye} />
      {includeHighlight ? (
        <rect x={eyeX + 1} y={eyeY + 1} width="3" height="3" fill={highlight} />
      ) : null}
    </>
  );
  const renderMouth = (
    style = mouthStyle,
    x = mouthX,
    mouthTop = faceMouthY,
    width = mouthWidth,
    height = mouthHeight
  ) => {
    if (style === "none") {
      return null;
    }

    if (style === "open") {
      return (
        <>
          <rect x={x} y={mouthTop} width={width} height={height + 7} fill={faceMouthColor} />
          <rect x={x + 2} y={mouthTop + 2} width={Math.max(3, width - 4)} height="3" fill="#332520" />
        </>
      );
    }

    if (style === "smile") {
      return (
        <>
          <rect x={x} y={mouthTop} width={width} height={height} fill={faceMouthColor} />
          <rect x={x - 3} y={mouthTop - 3} width="4" height={height} fill={faceMouthColor} />
          <rect x={x + width - 1} y={mouthTop - 3} width="4" height={height} fill={faceMouthColor} />
        </>
      );
    }

    return <rect x={x} y={mouthTop} width={width} height={height} fill={faceMouthColor} />;
  };

  if (expression === "fainted") {
    return (
      <>
        <rect x={leftX - 3} y={y - 3} width="5" height="5" fill={eye} />
        <rect x={leftX + 3} y={y + 3} width="5" height="5" fill={eye} />
        <rect x={leftX + 3} y={y - 3} width="5" height="5" fill={eye} />
        <rect x={leftX - 3} y={y + 3} width="5" height="5" fill={eye} />
        {secondEyeX === null ? null : (
          <>
            <rect x={secondEyeX - 3} y={y - 3} width="5" height="5" fill={eye} />
            <rect x={secondEyeX + 3} y={y + 3} width="5" height="5" fill={eye} />
            <rect x={secondEyeX + 3} y={y - 3} width="5" height="5" fill={eye} />
            <rect x={secondEyeX - 3} y={y + 3} width="5" height="5" fill={eye} />
          </>
        )}
        {renderMouth("flat", mouthX - 2, faceMouthY + 1, mouthWidth + 5, mouthHeight)}
      </>
    );
  }

  if (expression === "shaken") {
    return (
      <>
        <rect x={leftX - 2} y={y - 2} width="5" height="5" fill={eye} />
        <rect x={leftX + 3} y={y + 3} width="5" height="5" fill={eye} />
        <rect x={leftX - 2} y={y + 8} width="5" height="5" fill={eye} />
        {secondEyeX === null ? null : (
          <>
            <rect x={secondEyeX + 3} y={y - 2} width="5" height="5" fill={eye} />
            <rect x={secondEyeX - 2} y={y + 3} width="5" height="5" fill={eye} />
            <rect x={secondEyeX + 3} y={y + 8} width="5" height="5" fill={eye} />
          </>
        )}
        {renderMouth("open", mouthX, faceMouthY, Math.max(6, mouthWidth - 1), mouthHeight)}
      </>
    );
  }

  if (expression === "shocked") {
    return (
      <>
        <g className="cloud-code-monster-pet-eyes-track" transform={`translate(${eyeOffset.x} ${eyeOffset.y})`}>
          <rect className="cloud-code-monster-pet-eye-blink" x={leftX - 3} y={y - 3} width="12" height="13" fill={eye} />
          {secondEyeX === null ? null : (
            <rect className="cloud-code-monster-pet-eye-blink" x={secondEyeX - 3} y={y - 3} width="12" height="13" fill={eye} />
          )}
          <g transform={`translate(${eyeOffset.x * 0.45} ${eyeOffset.y * 0.45})`}>
            <rect x={leftX} y={y} width="4" height="4" fill={highlight} />
            {secondEyeX === null ? null : (
              <rect x={secondEyeX} y={y} width="4" height="4" fill={highlight} />
            )}
          </g>
        </g>
        {renderMouth("open", mouthX, faceMouthY - 3, mouthWidth, mouthHeight + 1)}
      </>
    );
  }

  if (expression === "sleeping") {
    return (
      <>
        <rect x={leftX - 2} y={y + 3} width="12" height="4" fill={eye} />
        {secondEyeX === null ? null : (
          <rect x={secondEyeX - 2} y={y + 3} width="12" height="4" fill={eye} />
        )}
        {renderMouth("flat", mouthX, faceMouthY, mouthWidth, mouthHeight)}
      </>
    );
  }

  return (
    <>
      <g className="cloud-code-monster-pet-eyes-track" transform={`translate(${eyeOffset.x} ${eyeOffset.y})`}>
        {renderEyeBlock(leftX, y)}
        {secondEyeX === null ? null : renderEyeBlock(secondEyeX, y)}
      </g>
      {renderMouth()}
    </>
  );
}

export function MonsterDirectPixelCharacter({
  preset,
  activityId,
  reacting,
  shaken,
  fainted,
  eyeOffset,
}: {
  preset: CloudCodeMonsterPetPreset;
  activityId: CloudCodeMonsterActivityId | null;
  reacting: boolean;
  shaken: boolean;
  fainted: boolean;
  eyeOffset?: { x: number; y: number };
}) {
  const shape = preset.shape;
  const expression = getCloudCodeMonsterExpression(
    activityId,
    reacting,
    shaken,
    fainted
  );

  switch (shape) {
    case "gadget-buddy":
      return (
        <>
          <rect x="36" y="23" width="56" height="13" fill="#2d9bd3" />
          <rect x="28" y="36" width="72" height="45" fill="#2d9bd3" />
          <rect x="37" y="43" width="54" height="36" fill="#f8fbff" />
          <rect x="44" y="80" width="40" height="22" fill="#2d9bd3" />
          <rect x="34" y="81" width="60" height="6" fill="#d9403f" />
          <rect x="58" y="87" width="13" height="12" fill="#f0bf36" />
          <rect className="cloud-code-monster-pet-left-foot" x="36" y="103" width="21" height="11" fill="#f8fbff" />
          <rect className="cloud-code-monster-pet-right-foot" x="72" y="103" width="21" height="11" fill="#f8fbff" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={45} rightX={76} y={44} mouthX={56} mouthY={71} mouthWidth={18} mouthHeight={3} mouthColor="#111318" mouthStyle="smile" />
          <rect x="62" y="55" width="6" height="6" fill="#d9403f" />
          <rect x="62" y="61" width="3" height="12" fill="#111318" />
          <rect x="54" y="73" width="20" height="3" fill="#111318" />
        </>
      );
    case "electric-mascot":
      return (
        <>
          <rect x="31" y="15" width="10" height="31" fill="#2b2319" />
          <rect x="87" y="15" width="10" height="31" fill="#2b2319" />
          <rect x="36" y="25" width="10" height="27" fill="#f1ce43" />
          <rect x="82" y="25" width="10" height="27" fill="#f1ce43" />
          <rect x="37" y="39" width="54" height="14" fill="#f4d64f" />
          <rect x="29" y="53" width="70" height="44" fill="#f1c93b" />
          <rect x="93" y="59" width="19" height="10" fill="#8d5d28" />
          <rect x="105" y="49" width="10" height="20" fill="#f1c93b" />
          <rect className="cloud-code-monster-pet-left-foot" x="37" y="96" width="18" height="15" fill="#d7a72e" />
          <rect className="cloud-code-monster-pet-right-foot" x="74" y="96" width="18" height="15" fill="#d7a72e" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={45} rightX={77} y={54} />
          <rect x="34" y="68" width="11" height="10" fill="#e84b43" />
          <rect x="84" y="68" width="11" height="10" fill="#e84b43" />
        </>
      );
    case "star-puff":
      return (
        <>
          <rect x="42" y="29" width="44" height="9" fill="#f2a8bd" />
          <rect x="29" y="38" width="70" height="52" fill="#ee86a7" />
          <rect x="40" y="90" width="48" height="13" fill="#d96c91" />
          <rect x="18" y="57" width="17" height="18" fill="#ee86a7" />
          <rect x="93" y="57" width="17" height="18" fill="#ee86a7" />
          <rect className="cloud-code-monster-pet-left-foot" x="35" y="100" width="22" height="12" fill="#c94d62" />
          <rect className="cloud-code-monster-pet-right-foot" x="72" y="100" width="22" height="12" fill="#c94d62" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={48} rightX={75} y={51} color="#24335b" mouthX={61} mouthY={66} mouthWidth={10} mouthHeight={5} mouthColor="#7c2448" mouthStyle="smile" />
          <rect x="43" y="69" width="9" height="8" fill="#e95d77" />
          <rect x="83" y="69" width="9" height="8" fill="#e95d77" />
        </>
      );
    case "leaf-bud-shape":
      return (
        <>
          <rect x="45" y="20" width="38" height="18" fill="#5e9f5b" />
          <rect x="38" y="31" width="52" height="22" fill="#74b86b" />
          <rect x="30" y="50" width="68" height="38" fill="#69b8a6" />
          <rect x="20" y="64" width="22" height="23" fill="#69b8a6" />
          <rect x="86" y="64" width="22" height="23" fill="#4c9f92" />
          <rect className="cloud-code-monster-pet-left-foot" x="29" y="88" width="16" height="16" fill="#4c9f92" />
          <rect className="cloud-code-monster-pet-right-foot" x="82" y="88" width="16" height="16" fill="#408b80" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={44} rightX={74} y={56} color="#b33b42" />
          <rect x="53" y="75" width="7" height="4" fill="#2d5d56" />
          <rect x="67" y="75" width="7" height="4" fill="#2d5d56" />
        </>
      );
    case "ember-scout":
      return (
        <>
          <rect x="38" y="29" width="50" height="13" fill="#e88743" />
          <rect x="30" y="42" width="66" height="45" fill="#d76d35" />
          <rect x="41" y="70" width="39" height="28" fill="#f2c878" />
          <rect x="88" y="70" width="17" height="10" fill="#d76d35" />
          <rect x="101" y="58" width="9" height="15" fill="#f0b540" />
          <rect x="103" y="51" width="7" height="9" fill="#e24c38" />
          <rect className="cloud-code-monster-pet-left-foot" x="36" y="98" width="17" height="14" fill="#b9542c" />
          <rect className="cloud-code-monster-pet-right-foot" x="75" y="98" width="17" height="14" fill="#b9542c" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={48} rightX={77} y={50} />
        </>
      );
    case "shell-sprout":
      return (
        <>
          <rect x="39" y="27" width="50" height="13" fill="#83b7d8" />
          <rect x="31" y="40" width="66" height="39" fill="#6aa4cf" />
          <rect x="37" y="76" width="55" height="25" fill="#b9854a" />
          <rect x="45" y="80" width="39" height="17" fill="#ecd59a" />
          <rect x="16" y="62" width="20" height="16" fill="#6aa4cf" />
          <rect x="92" y="62" width="20" height="16" fill="#6aa4cf" />
          <rect className="cloud-code-monster-pet-left-foot" x="35" y="101" width="18" height="12" fill="#5c92bd" />
          <rect className="cloud-code-monster-pet-right-foot" x="76" y="101" width="18" height="12" fill="#5c92bd" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={46} rightX={76} y={48} />
        </>
      );
    case "block-builder-shape":
      return (
        <>
          <rect x="42" y="18" width="44" height="14" fill="#5b3625" />
          <rect x="36" y="32" width="56" height="42" fill="#b98363" />
          <rect x="36" y="74" width="56" height="28" fill="#2b9aa0" />
          <rect x="28" y="78" width="11" height="28" fill="#b98363" />
          <rect x="89" y="78" width="11" height="28" fill="#b98363" />
          <rect className="cloud-code-monster-pet-left-foot" x="42" y="102" width="18" height="16" fill="#31549a" />
          <rect className="cloud-code-monster-pet-right-foot" x="68" y="102" width="18" height="16" fill="#31549a" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={48} rightX={73} y={46} color="#2b2018" mouthX={57} mouthY={59} mouthWidth={14} mouthHeight={4} mouthColor="#6c3f2b" />
          <rect x="57" y="59" width="14" height="4" fill="#6c3f2b" />
        </>
      );
    case "block-hiss-shape":
      return (
        <>
          <rect x="37" y="20" width="54" height="54" fill="#5aaa4c" />
          <rect x="44" y="27" width="10" height="10" fill="#78c763" />
          <rect x="72" y="34" width="11" height="11" fill="#458d3d" />
          <rect x="42" y="74" width="44" height="32" fill="#4b963f" />
          <rect className="cloud-code-monster-pet-left-foot" x="34" y="101" width="18" height="15" fill="#397b35" />
          <rect className="cloud-code-monster-pet-left-foot" x="54" y="101" width="18" height="15" fill="#397b35" />
          <rect className="cloud-code-monster-pet-right-foot" x="76" y="101" width="18" height="15" fill="#397b35" />
          {expression === "sleeping" ? (
            <>
              <rect x="47" y="46" width="12" height="4" fill="#151711" />
              <rect x="69" y="46" width="12" height="4" fill="#151711" />
              <rect x="58" y="61" width="12" height="4" fill="#151711" />
            </>
          ) : (
            <>
              <rect x="47" y="40" width="11" height="13" fill="#151711" />
              <rect x="70" y="40" width="11" height="13" fill="#151711" />
              <rect x="59" y="54" width="10" height="18" fill="#151711" />
              <rect x="51" y="64" width="10" height="8" fill="#151711" />
              <rect x="67" y="64" width="10" height="8" fill="#151711" />
            </>
          )}
        </>
      );
    case "block-walker-shape":
      return (
        <>
          <rect x="38" y="22" width="52" height="49" fill="#77a86c" />
          <rect x="37" y="71" width="54" height="31" fill="#248f9e" />
          <rect x="25" y="74" width="14" height="30" fill="#77a86c" />
          <rect x="89" y="74" width="14" height="30" fill="#77a86c" />
          <rect className="cloud-code-monster-pet-left-foot" x="41" y="102" width="18" height="16" fill="#5d4aa1" />
          <rect className="cloud-code-monster-pet-right-foot" x="69" y="102" width="18" height="16" fill="#5d4aa1" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={49} rightX={73} y={43} color="#2b221d" mouthX={57} mouthY={58} mouthWidth={14} mouthHeight={4} mouthColor="#2b221d" />
          <rect x="57" y="58" width="14" height="4" fill="#2b221d" />
        </>
      );
    case "mushroom-pal-shape":
      return (
        <>
          <rect x="29" y="19" width="70" height="22" fill="#fff3e4" />
          <rect x="38" y="8" width="52" height="18" fill="#fff3e4" />
          <rect x="42" y="20" width="16" height="13" fill="#d84741" />
          <rect x="70" y="16" width="15" height="13" fill="#d84741" />
          <rect x="39" y="43" width="50" height="40" fill="#f0c89c" />
          <rect x="36" y="78" width="56" height="24" fill="#f7f1dc" />
          <rect x="31" y="80" width="11" height="20" fill="#2d5ca8" />
          <rect x="86" y="80" width="11" height="20" fill="#2d5ca8" />
          <rect className="cloud-code-monster-pet-left-foot" x="38" y="102" width="17" height="12" fill="#7a5735" />
          <rect className="cloud-code-monster-pet-right-foot" x="73" y="102" width="17" height="12" fill="#7a5735" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={48} rightX={74} y={54} />
        </>
      );
    case "blue-spinner":
      return (
        <>
          <rect x="33" y="22" width="17" height="13" fill="#2d62b3" />
          <rect x="43" y="13" width="22" height="14" fill="#2d62b3" />
          <rect x="61" y="17" width="23" height="12" fill="#2d62b3" />
          <rect x="36" y="31" width="55" height="42" fill="#356fc1" />
          <rect x="42" y="48" width="40" height="25" fill="#e4c19b" />
          <rect x="44" y="74" width="39" height="26" fill="#356fc1" />
          <rect className="cloud-code-monster-pet-left-foot" x="31" y="99" width="26" height="12" fill="#d9463f" />
          <rect className="cloud-code-monster-pet-right-foot" x="71" y="99" width="26" height="12" fill="#d9463f" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={49} rightX={74} y={42} />
        </>
      );
    case "arcade-chomper":
      return (
        <>
          <rect x="43" y="28" width="45" height="11" fill="#f1d34a" />
          <rect x="31" y="39" width="56" height="49" fill="#edc738" />
          <rect x="42" y="88" width="44" height="11" fill="#cfa62a" />
          <rect x="82" y="52" width="20" height="11" fill="#fff8de" />
          <rect x="82" y="65" width="15" height="11" fill="#fff8de" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={58} rightX={58} y={43} singleEye mouthX={84} mouthY={62} mouthWidth={15} mouthHeight={7} mouthColor="#15110d" mouthStyle="open" />
        </>
      );
    case "peek-ghost-shape":
      return (
        <>
          <rect x="39" y="26" width="50" height="12" fill="#f0f2fb" />
          <rect x="29" y="38" width="70" height="48" fill="#e0e5f3" />
          <rect x="23" y="55" width="13" height="18" fill="#e0e5f3" />
          <rect x="92" y="55" width="13" height="18" fill="#d0d8ea" />
          <rect x="31" y="86" width="13" height="12" fill="#e0e5f3" />
          <rect x="56" y="86" width="13" height="12" fill="#e0e5f3" />
          <rect x="81" y="86" width="13" height="12" fill="#e0e5f3" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={45} rightX={77} y={47} mouthX={56} mouthY={63} mouthWidth={19} mouthHeight={10} mouthColor="#df7198" mouthStyle="open" />
          <rect x="57" y="63" width="18" height="13" fill="#df7198" />
        </>
      );
    case "cap-jumper":
      return (
        <>
          <rect x="35" y="18" width="58" height="12" fill="#d34437" />
          <rect x="46" y="9" width="35" height="12" fill="#d34437" />
          <rect x="39" y="31" width="50" height="38" fill="#c8916b" />
          <rect x="52" y="55" width="28" height="8" fill="#4c2d20" />
          <rect x="36" y="69" width="56" height="32" fill="#2f5aa8" />
          <rect x="30" y="71" width="14" height="28" fill="#d34437" />
          <rect x="84" y="71" width="14" height="28" fill="#d34437" />
          <rect className="cloud-code-monster-pet-left-foot" x="35" y="101" width="21" height="13" fill="#6c3e27" />
          <rect className="cloud-code-monster-pet-right-foot" x="72" y="101" width="21" height="13" fill="#6c3e27" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={49} rightX={74} y={41} />
        </>
      );
    case "honey-cub-shape":
      return (
        <>
          <rect x="31" y="30" width="13" height="14" fill="#d99b39" />
          <rect x="84" y="30" width="13" height="14" fill="#c88730" />
          <rect x="38" y="26" width="52" height="46" fill="#e0a33f" />
          <rect x="32" y="72" width="64" height="29" fill="#c9473c" />
          <rect className="cloud-code-monster-pet-left-foot" x="37" y="101" width="18" height="14" fill="#b87a2e" />
          <rect className="cloud-code-monster-pet-right-foot" x="74" y="101" width="18" height="14" fill="#b87a2e" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={48} rightX={75} y={47} />
          <rect x="61" y="59" width="7" height="5" fill="#4a2c1e" />
        </>
      );
    case "ribbon-cat-shape":
      return (
        <>
          <rect x="28" y="25" width="16" height="18" fill="#f6f3ea" />
          <rect x="84" y="25" width="16" height="18" fill="#f6f3ea" />
          <rect x="33" y="31" width="62" height="45" fill="#f6f3ea" />
          <rect x="76" y="24" width="13" height="13" fill="#d94c5e" />
          <rect x="91" y="24" width="13" height="13" fill="#d94c5e" />
          <rect x="87" y="28" width="8" height="8" fill="#e8c94a" />
          <rect x="39" y="76" width="50" height="26" fill="#d94c5e" />
          <rect className="cloud-code-monster-pet-left-foot" x="38" y="102" width="18" height="11" fill="#f6f3ea" />
          <rect className="cloud-code-monster-pet-right-foot" x="72" y="102" width="18" height="11" fill="#f6f3ea" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={46} rightX={78} y={49} color="#25201f" highlightColor="#fffdfa" mouthX={61} mouthY={64} mouthWidth={7} mouthHeight={2} mouthColor="#7b4542" mouthStyle="smile" />
          <rect x="61" y="58" width="8" height="6" fill="#e0ad31" />
          <rect x="63" y="59" width="4" height="3" fill="#f6d75b" />
          <rect x="39" y="58" width="7" height="2" fill="#25201f" opacity="0.72" />
          <rect x="82" y="58" width="7" height="2" fill="#25201f" opacity="0.72" />
        </>
      );
    case "cozy-hood-bunny-shape":
    case "imp-hood-shape": {
      const isImpHood = shape === "imp-hood-shape";
      const hood = isImpHood ? "#51425c" : "#e78eaa";
      const accent = isImpHood ? "#dd6d99" : "#d84c64";
      return (
        <>
          <rect x="27" y="12" width="13" height="42" fill={hood} />
          <rect x="88" y="12" width="13" height="42" fill={hood} />
          <rect x="35" y="25" width="58" height="54" fill={hood} />
          <rect x="42" y="39" width="44" height="34" fill="#fff5ee" />
          {isImpHood ? (
            <>
              <rect x="57" y="28" width="14" height="10" fill="#f2e9e1" />
              <rect x="60" y="31" width="3" height="3" fill="#51425c" />
              <rect x="66" y="31" width="3" height="3" fill="#51425c" />
              <rect x="63" y="35" width="3" height="2" fill="#51425c" />
            </>
          ) : null}
          <rect x="48" y="57" width="7" height="6" fill={isImpHood ? "#f2dfe8" : "#f3d6dc"} />
          <rect x="76" y="57" width="7" height="6" fill={isImpHood ? "#f2dfe8" : "#f3d6dc"} />
          <rect x="38" y="79" width="52" height="25" fill={accent} />
          <rect className="cloud-code-monster-pet-left-foot" x="39" y="104" width="17" height="10" fill={hood} />
          <rect className="cloud-code-monster-pet-right-foot" x="72" y="104" width="17" height="10" fill={hood} />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={50} rightX={75} y={49} color="#31232f" highlightColor="#fff5ee" mouthX={60} mouthY={64} mouthWidth={9} mouthHeight={3} mouthColor="#7a3c55" mouthStyle="smile" />
        </>
      );
    }
    case "forest-neighbor-shape":
      return (
        <>
          <rect x="38" y="16" width="10" height="22" fill="#74766a" />
          <rect x="80" y="16" width="10" height="22" fill="#74766a" />
          <rect x="36" y="30" width="56" height="17" fill="#85877a" />
          <rect x="24" y="47" width="80" height="54" fill="#74766a" />
          <rect x="38" y="65" width="52" height="33" fill="#dad3b8" />
          <rect x="46" y="72" width="8" height="5" fill="#74766a" />
          <rect x="61" y="72" width="8" height="5" fill="#74766a" />
          <rect x="76" y="72" width="8" height="5" fill="#74766a" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={47} rightX={76} y={47} />
        </>
      );
    case "dust-puff-shape":
      return (
        <>
          <rect x="38" y="29" width="52" height="9" fill="#2b2c31" />
          <rect x="27" y="38" width="74" height="45" fill="#1f2026" />
          <rect x="36" y="83" width="56" height="12" fill="#17181e" />
          <rect x="22" y="45" width="9" height="9" fill="#1f2026" />
          <rect x="97" y="48" width="9" height="9" fill="#1f2026" />
          {expression === "sleeping" ? (
            <>
              <rect x="48" y="59" width="14" height="3" fill="#f5f2dc" />
              <rect x="69" y="59" width="14" height="3" fill="#f5f2dc" />
            </>
          ) : (
            <>
              <rect x="48" y="52" width="14" height="14" fill="#f5f2dc" />
              <rect x="69" y="52" width="14" height="14" fill="#f5f2dc" />
              <g className="cloud-code-monster-pet-eyes-track" transform={`translate(${eyeOffset?.x ?? 0} ${eyeOffset?.y ?? 0})`}>
                <rect className="cloud-code-monster-pet-eye-blink" x="53" y="56" width="5" height="6" fill="#17181e" />
                <rect className="cloud-code-monster-pet-eye-blink" x="74" y="56" width="5" height="6" fill="#17181e" />
              </g>
            </>
          )}
        </>
      );
    case "straw-voyager-shape":
      return (
        <>
          <rect x="31" y="18" width="66" height="9" fill="#e7c65d" />
          <rect x="40" y="8" width="48" height="15" fill="#e7c65d" />
          <rect x="43" y="22" width="42" height="6" fill="#c84f3e" />
          <rect x="38" y="31" width="52" height="39" fill="#d89064" />
          <rect x="36" y="70" width="56" height="31" fill="#cf4d3f" />
          <rect x="45" y="82" width="38" height="20" fill="#2c5ca0" />
          <rect className="cloud-code-monster-pet-left-foot" x="39" y="102" width="18" height="13" fill="#d89064" />
          <rect className="cloud-code-monster-pet-right-foot" x="71" y="102" width="18" height="13" fill="#d89064" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={49} rightX={75} y={44} />
        </>
      );
    case "leaf-runner-shape":
      return (
        <>
          <rect x="34" y="18" width="11" height="16" fill="#e0a641" />
          <rect x="48" y="12" width="10" height="22" fill="#e0a641" />
          <rect x="61" y="14" width="10" height="20" fill="#e0a641" />
          <rect x="75" y="18" width="11" height="16" fill="#e0a641" />
          <rect x="36" y="32" width="56" height="9" fill="#2f4560" />
          <rect x="55" y="34" width="18" height="6" fill="#c9ccd2" />
          <rect x="38" y="41" width="52" height="34" fill="#dfa06c" />
          <rect x="34" y="75" width="60" height="31" fill="#e27a31" />
          <rect className="cloud-code-monster-pet-left-foot" x="39" y="106" width="18" height="10" fill="#2f4560" />
          <rect className="cloud-code-monster-pet-right-foot" x="72" y="106" width="18" height="10" fill="#2f4560" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={49} rightX={75} y={50} />
        </>
      );
    case "energy-pearl-shape":
      return (
        <>
          <rect x="35" y="14" width="13" height="23" fill="#191817" />
          <rect x="50" y="6" width="13" height="31" fill="#191817" />
          <rect x="66" y="9" width="13" height="28" fill="#191817" />
          <rect x="80" y="18" width="12" height="19" fill="#191817" />
          <rect x="38" y="35" width="52" height="38" fill="#dc9864" />
          <rect x="33" y="73" width="62" height="31" fill="#df7a30" />
          <rect x="52" y="77" width="24" height="29" fill="#244f91" />
          <rect className="cloud-code-monster-pet-left-foot" x="39" y="104" width="19" height="12" fill="#244f91" />
          <rect className="cloud-code-monster-pet-right-foot" x="71" y="104" width="19" height="12" fill="#244f91" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={49} rightX={75} y={47} />
        </>
      );
    case "moon-wand-shape":
      return (
        <>
          <rect x="29" y="24" width="14" height="14" fill="#e6c44e" />
          <rect x="85" y="24" width="14" height="14" fill="#e6c44e" />
          <rect x="40" y="12" width="48" height="31" fill="#e6c44e" />
          <rect x="38" y="38" width="52" height="35" fill="#e6a96b" />
          <rect x="34" y="73" width="60" height="31" fill="#f3eee9" />
          <rect x="42" y="72" width="44" height="8" fill="#2f5ca9" />
          <rect x="58" y="80" width="12" height="19" fill="#d9495d" />
          <rect className="cloud-code-monster-pet-left-foot" x="38" y="104" width="18" height="10" fill="#d9495d" />
          <rect className="cloud-code-monster-pet-right-foot" x="72" y="104" width="18" height="10" fill="#d9495d" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={49} rightX={75} y={48} />
        </>
      );
    case "mecha-guard-shape":
      return (
        <>
          <rect x="38" y="25" width="52" height="39" fill="#d7dbe2" />
          <rect x="31" y="28" width="10" height="18" fill="#d94b43" />
          <rect x="87" y="28" width="10" height="18" fill="#d94b43" />
          <rect x="54" y="17" width="7" height="17" fill="#e8c64c" />
          <rect x="68" y="17" width="7" height="17" fill="#e8c64c" />
          <rect x="45" y="44" width="38" height="8" fill="#26344f" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={50} rightX={70} y={44} color="#edf6ff" highlightColor="#7fd7ff" mouthX={58} mouthY={57} mouthWidth={13} mouthHeight={3} mouthColor="#d94b43" />
          <rect x="34" y="64" width="60" height="39" fill="#eef1f5" />
          <rect x="48" y="68" width="32" height="19" fill="#315aa8" />
          <rect x="56" y="70" width="16" height="12" fill="#d94b43" />
          <rect className="cloud-code-monster-pet-left-foot" x="38" y="103" width="20" height="12" fill="#26344f" />
          <rect className="cloud-code-monster-pet-right-foot" x="70" y="103" width="20" height="12" fill="#26344f" />
        </>
      );
    case "teardrop-slime-shape":
      return (
        <>
          <rect x="56" y="16" width="16" height="15" fill="#80c4ef" />
          <rect x="42" y="31" width="44" height="13" fill="#69aee2" />
          <rect x="29" y="44" width="70" height="43" fill="#5aa0d8" />
          <rect x="39" y="87" width="50" height="12" fill="#4384ba" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={47} rightX={76} y={55} mouthX={58} mouthY={72} mouthWidth={14} mouthHeight={5} mouthColor="#c4444a" mouthStyle="smile" />
          <rect x="58" y="72" width="14" height="5" fill="#c4444a" />
        </>
      );
    case "ink-runner-shape":
      return (
        <>
          <rect x="50" y="13" width="11" height="28" fill="#61c3b8" />
          <rect x="67" y="13" width="11" height="28" fill="#61c3b8" />
          <rect x="38" y="31" width="52" height="43" fill="#54afa2" />
          <rect x="32" y="72" width="15" height="29" fill="#54afa2" />
          <rect x="56" y="72" width="15" height="29" fill="#3f9188" />
          <rect x="81" y="72" width="15" height="29" fill="#3f9188" />
          <rect x="41" y="78" width="46" height="17" fill="#25292f" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={48} rightX={74} y={45} />
        </>
      );
    case "little-beagle-shape":
      return (
        <>
          <rect x="42" y="23" width="36" height="9" fill="#fffaf0" />
          <rect x="34" y="32" width="55" height="14" fill="#fffaf0" />
          <rect x="32" y="46" width="61" height="18" fill="#f4f1e8" />
          <rect x="43" y="64" width="43" height="10" fill="#e6dfd2" />
          <rect x="82" y="39" width="20" height="10" fill="#fffaf0" />
          <rect x="92" y="49" width="17" height="12" fill="#fffaf0" />
          <rect x="101" y="43" width="11" height="10" fill="#1f1f22" />
          <rect x="106" y="48" width="7" height="8" fill="#1f1f22" />
          <rect x="23" y="31" width="18" height="14" fill="#1f1f22" />
          <rect x="19" y="45" width="23" height="30" fill="#1f1f22" />
          <rect x="23" y="75" width="16" height="12" fill="#1f1f22" />
          <rect x="28" y="36" width="7" height="31" fill="#373234" />
          <rect x="39" y="74" width="50" height="7" fill="#d84c43" />
          <rect x="42" y="81" width="51" height="22" fill="#fffaf0" />
          <rect x="35" y="88" width="12" height="18" fill="#fffaf0" />
          <rect x="88" y="82" width="13" height="13" fill="#fffaf0" />
          <rect x="98" y="79" width="8" height="8" fill="#fffaf0" />
          <rect x="48" y="101" width="11" height="6" fill="#e6dfd2" />
          <rect x="75" y="101" width="11" height="6" fill="#e6dfd2" />
          <rect className="cloud-code-monster-pet-left-foot" x="36" y="104" width="24" height="10" fill="#fffaf0" />
          <rect className="cloud-code-monster-pet-right-foot" x="70" y="104" width="24" height="10" fill="#fffaf0" />
          <rect x="36" y="112" width="24" height="4" fill="#e6dfd2" />
          <rect x="70" y="112" width="24" height="4" fill="#e6dfd2" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={61} rightX={61} y={43} color="#1f1f22" highlightColor="#fffaf0" singleEye mouthX={86} mouthY={59} mouthWidth={11} mouthHeight={3} mouthColor="#1f1f22" mouthStyle="flat" />
        </>
      );
    case "tiny-antler-shape":
      return (
        <>
          <rect x="32" y="19" width="14" height="8" fill="#b07d55" />
          <rect x="82" y="19" width="14" height="8" fill="#b07d55" />
          <rect x="27" y="25" width="13" height="30" fill="#b07d55" />
          <rect x="88" y="25" width="13" height="30" fill="#b07d55" />
          <rect x="38" y="19" width="52" height="19" fill="#df84b2" />
          <rect x="48" y="10" width="32" height="15" fill="#df84b2" />
          <rect x="38" y="38" width="52" height="39" fill="#bd7d55" />
          <rect x="45" y="54" width="38" height="22" fill="#f0cba6" />
          <rect x="36" y="77" width="56" height="27" fill="#c95b70" />
          <rect className="cloud-code-monster-pet-left-foot" x="39" y="104" width="18" height="10" fill="#bd7d55" />
          <rect className="cloud-code-monster-pet-right-foot" x="72" y="104" width="18" height="10" fill="#bd7d55" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} eyeOffset={eyeOffset} leftX={49} rightX={75} y={49} />
        </>
      );
    default:
      return null;
  }
}
