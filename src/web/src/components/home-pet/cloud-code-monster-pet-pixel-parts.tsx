import { lazy, Suspense } from "react";
import { getCloudCodeMonsterExpression } from "./cloud-code-monster-pet-activity";
import type {
  CloudCodeMonsterActivityId,
  CloudCodeMonsterPetPreset,
} from "./cloud-code-monster-pet-types";

const LazyMonsterDirectPixelCharacter = lazy(() =>
  import("./cloud-code-monster-pet-direct-shapes").then((module) => ({
    default: module.MonsterDirectPixelCharacter,
  }))
);

function MonsterEyes({
  activityId,
  preset,
  reacting,
  shaken,
  fainted = false,
  eyeOffset = { x: 0, y: 0 },
}: {
  activityId: CloudCodeMonsterActivityId | null;
  preset: CloudCodeMonsterPetPreset;
  reacting: boolean;
  shaken: boolean;
  fainted?: boolean;
  eyeOffset?: { x: number; y: number };
}) {
  const expression = getCloudCodeMonsterExpression(
    activityId,
    reacting,
    shaken,
    fainted
  );

  if (expression === "fainted") {
    return (
      <>
        <rect x="43" y="39" width="5" height="5" fill={preset.eye} />
        <rect x="49" y="45" width="5" height="5" fill={preset.eye} />
        <rect x="43" y="51" width="5" height="5" fill={preset.eye} />
        <rect x="49" y="39" width="5" height="5" fill={preset.eye} />
        <rect x="43" y="45" width="5" height="5" fill={preset.eye} />
        <rect x="76" y="39" width="5" height="5" fill={preset.eye} />
        <rect x="82" y="45" width="5" height="5" fill={preset.eye} />
        <rect x="76" y="51" width="5" height="5" fill={preset.eye} />
        <rect x="82" y="39" width="5" height="5" fill={preset.eye} />
        <rect x="76" y="45" width="5" height="5" fill={preset.eye} />
        <rect x="58" y="64" width="14" height="4" fill={preset.eye} />
      </>
    );
  }

  if (expression === "shaken") {
    return (
      <>
        <rect x="45" y="40" width="5" height="5" fill={preset.eye} />
        <rect x="50" y="45" width="5" height="5" fill={preset.eye} />
        <rect x="45" y="50" width="5" height="5" fill={preset.eye} />
        <rect x="82" y="40" width="5" height="5" fill={preset.eye} />
        <rect x="77" y="45" width="5" height="5" fill={preset.eye} />
        <rect x="82" y="50" width="5" height="5" fill={preset.eye} />
        <rect x="62" y="61" width="6" height="4" fill={preset.eye} />
      </>
    );
  }

  if (expression === "shocked") {
    return (
      <>
        <g className="cloud-code-monster-pet-eyes-track" transform={`translate(${eyeOffset.x} ${eyeOffset.y})`}>
          <rect className="cloud-code-monster-pet-eye-blink" x="44" y="39" width="12" height="13" fill={preset.eye} />
          <rect className="cloud-code-monster-pet-eye-blink" x="76" y="39" width="12" height="13" fill={preset.eye} />
          <g transform={`translate(${eyeOffset.x * 0.45} ${eyeOffset.y * 0.45})`}>
            <rect x="47" y="42" width="4" height="4" fill={preset.highlight} />
            <rect x="79" y="42" width="4" height="4" fill={preset.highlight} />
          </g>
        </g>
        <rect x="60" y="60" width="10" height="12" fill={preset.eye} />
        <rect x="62" y="62" width="6" height="3" fill="#332520" />
      </>
    );
  }

  if (expression === "sleeping") {
    return (
      <>
        <rect x="45" y="46" width="11" height="4" fill={preset.eye} />
        <rect x="76" y="46" width="11" height="4" fill={preset.eye} />
      </>
    );
  }

  return (
    <g className="cloud-code-monster-pet-eyes-track" transform={`translate(${eyeOffset.x} ${eyeOffset.y})`}>
      <rect className="cloud-code-monster-pet-eye-blink" x="44" y="42" width="11" height="12" fill={preset.eye} />
      <rect className="cloud-code-monster-pet-eye-blink" x="77" y="42" width="11" height="12" fill={preset.eye} />
      <g transform={`translate(${eyeOffset.x * 0.55} ${eyeOffset.y * 0.55})`}>
        <rect x="46" y="44" width="4" height="4" fill="#2c2521" />
        <rect x="79" y="44" width="4" height="4" fill="#2c2521" />
      </g>
    </g>
  );
}

function MonsterActivityAccessory({
  activityId,
  preset,
}: {
  activityId: CloudCodeMonsterActivityId | null;
  preset: CloudCodeMonsterPetPreset;
}) {
  if (!activityId) {
    return null;
  }

  if (activityId === "sleeping" || activityId === "dozing" || activityId === "yawning") {
    return (
      <g className="cloud-code-monster-pet-accessory cloud-code-monster-pet-sleep">
        <g className="cloud-code-monster-pet-sleep-z">
          <rect x="88" y="20" width="11" height="3" fill={preset.accent} />
          <rect x="94" y="23" width="4" height="3" fill={preset.accent} />
          <rect x="91" y="26" width="4" height="3" fill={preset.accent} />
          <rect x="88" y="29" width="11" height="3" fill={preset.accent} />
        </g>
        <g className="cloud-code-monster-pet-sleep-z">
          <rect x="99" y="12" width="14" height="3" fill={preset.accent} />
          <rect x="108" y="15" width="4" height="3" fill={preset.accent} />
          <rect x="104" y="18" width="4" height="3" fill={preset.accent} />
          <rect x="100" y="21" width="4" height="3" fill={preset.accent} />
          <rect x="99" y="24" width="14" height="3" fill={preset.accent} />
        </g>
        <g className="cloud-code-monster-pet-sleep-z">
          <rect x="114" y="2" width="17" height="4" fill={preset.accent} />
          <rect x="126" y="6" width="4" height="4" fill={preset.accent} />
          <rect x="122" y="10" width="4" height="4" fill={preset.accent} />
          <rect x="118" y="14" width="4" height="4" fill={preset.accent} />
          <rect x="114" y="18" width="17" height="4" fill={preset.accent} />
        </g>
      </g>
    );
  }

  if (activityId === "reading") {
    return (
      <g className="cloud-code-monster-pet-accessory cloud-code-monster-pet-book">
        <rect x="39" y="70" width="24" height="24" fill="#f5e6b8" />
        <rect x="65" y="70" width="24" height="24" fill="#ead394" />
        <rect x="63" y="70" width="4" height="26" fill="#6e4e2a" />
        <rect x="45" y="77" width="12" height="3" fill="#9a733d" />
        <rect x="71" y="77" width="12" height="3" fill="#9a733d" />
        <rect x="45" y="84" width="9" height="3" fill="#9a733d" />
      </g>
    );
  }

  if (activityId === "phone") {
    return (
      <g className="cloud-code-monster-pet-accessory cloud-code-monster-pet-phone">
        <rect x="76" y="62" width="18" height="29" fill="#2b2724" />
        <rect x="80" y="66" width="10" height="17" fill="#9ed7d4" />
        <rect x="83" y="86" width="4" height="3" fill="#f4e7d2" />
        <rect className="cloud-code-monster-pet-phone-glow" x="80" y="66" width="10" height="17" fill="#d5fff6" />
      </g>
    );
  }

  if (activityId === "coding" || activityId === "typing") {
    return (
      <g className="cloud-code-monster-pet-accessory cloud-code-monster-pet-laptop">
        <rect x="35" y="68" width="58" height="25" fill="#2b2724" />
        <rect x="39" y="72" width="50" height="16" fill="#37322d" />
        <rect x="31" y="93" width="66" height="8" fill="#d8d0c6" />
        <rect x="47" y="77" width="10" height="3" fill={preset.accessory} />
        <rect x="58" y="80" width="4" height="3" fill={preset.accessory} />
        <rect x="66" y="83" width="13" height="3" fill={preset.accessory} />
      </g>
    );
  }

  if (activityId === "building") {
    return (
      <g className="cloud-code-monster-pet-accessory cloud-code-monster-pet-building">
        <rect x="29" y="72" width="19" height="19" fill={preset.accessory} />
        <rect x="52" y="62" width="20" height="29" fill={preset.accent} />
        <rect x="76" y="70" width="21" height="21" fill={preset.bodyLight} />
        <rect x="34" y="77" width="8" height="4" fill={preset.highlight} />
        <rect x="57" y="68" width="9" height="4" fill={preset.highlight} />
        <rect x="81" y="76" width="9" height="4" fill={preset.highlight} />
      </g>
    );
  }

  if (activityId === "juggling") {
    return (
      <g className="cloud-code-monster-pet-accessory cloud-code-monster-pet-juggling">
        <rect x="33" y="29" width="8" height="8" fill={preset.accessory} />
        <rect x="59" y="17" width="8" height="8" fill={preset.accent} />
        <rect x="86" y="29" width="8" height="8" fill={preset.bodyLight} />
      </g>
    );
  }

  if (activityId === "attention" || activityId === "waking") {
    return (
      <g className="cloud-code-monster-pet-accessory cloud-code-monster-pet-attention">
        <rect x="22" y="22" width="7" height="18" fill={preset.accessory} />
        <rect x="17" y="27" width="17" height="7" fill={preset.accessory} />
        <rect x="99" y="20" width="8" height="20" fill={preset.accent} />
        <rect x="93" y="26" width="20" height="8" fill={preset.accent} />
        <rect x="61" y="5" width="7" height="18" fill={preset.highlight} />
      </g>
    );
  }

  if (activityId === "error") {
    return (
      <g className="cloud-code-monster-pet-accessory cloud-code-monster-pet-error">
        <rect x="92" y="15" width="20" height="20" fill="#2b2112" />
        <rect x="96" y="19" width="12" height="12" fill="#f05f57" />
        <rect x="101" y="21" width="3" height="7" fill="#fff1d6" />
        <rect x="101" y="30" width="3" height="3" fill="#fff1d6" />
      </g>
    );
  }

  if (activityId === "carrying") {
    return (
      <g className="cloud-code-monster-pet-accessory cloud-code-monster-pet-carrying">
        <rect x="39" y="68" width="48" height="25" fill={preset.accessory} />
        <rect x="39" y="68" width="48" height="5" fill={preset.accent} />
        <rect x="61" y="68" width="5" height="25" fill={preset.accent} />
      </g>
    );
  }

  if (activityId === "sweeping") {
    return (
      <g className="cloud-code-monster-pet-accessory cloud-code-monster-pet-sweeping">
        <rect x="72" y="58" width="5" height="42" fill="#8b6538" />
        <rect x="62" y="94" width="27" height="7" fill={preset.accessory} />
        <rect x="58" y="101" width="35" height="5" fill={preset.accent} />
      </g>
    );
  }

  if (activityId === "snacking") {
    return (
      <g className="cloud-code-monster-pet-accessory cloud-code-monster-pet-snack">
        <rect x="77" y="65" width="17" height="21" fill="#efc06d" />
        <rect x="81" y="71" width="9" height="3" fill="#7d5723" />
        <rect x="81" y="78" width="7" height="3" fill="#7d5723" />
        <rect x="67" y="59" width="8" height="8" fill={preset.accent} />
      </g>
    );
  }

  return (
    <g className="cloud-code-monster-pet-accessory cloud-code-monster-pet-thought">
      <rect x="92" y="25" width="8" height="8" fill={preset.accent} />
      <rect x="104" y="17" width="6" height="6" fill={preset.bodyLight} />
      <rect x="113" y="9" width="5" height="5" fill={preset.highlight} />
    </g>
  );
}

function MonsterPresetFeature({
  preset,
}: {
  preset: CloudCodeMonsterPetPreset;
}) {
  const { feature } = preset;

  if (feature === "horns") {
    return (
      <>
        <rect x="29" y="20" width="10" height="8" fill={preset.accent} />
        <rect x="91" y="20" width="10" height="8" fill={preset.accent} />
        <rect x="34" y="16" width="7" height="7" fill={preset.accessory} />
        <rect x="88" y="16" width="7" height="7" fill={preset.accessory} />
      </>
    );
  }

  if (feature === "ears") {
    return (
      <>
        <rect x="18" y="38" width="10" height="18" fill={preset.bodyDark} />
        <rect x="100" y="38" width="10" height="18" fill={preset.bodyDark} />
        <rect x="21" y="42" width="5" height="8" fill={preset.bodyLight} />
        <rect x="102" y="42" width="5" height="8" fill={preset.bodyLight} />
      </>
    );
  }

  if (feature === "visor") {
    return (
      <>
        <rect x="41" y="36" width="47" height="5" fill={preset.accent} />
        <rect x="45" y="38" width="39" height="3" fill={preset.highlight} />
      </>
    );
  }

  if (feature === "antenna") {
    return (
      <>
        <rect x="62" y="15" width="5" height="13" fill={preset.accent} />
        <rect x="58" y="10" width="13" height="6" fill={preset.accessory} />
      </>
    );
  }

  if (feature === "crown") {
    return (
      <>
        <rect x="43" y="18" width="8" height="10" fill={preset.accessory} />
        <rect x="60" y="14" width="8" height="14" fill={preset.accessory} />
        <rect x="77" y="18" width="8" height="10" fill={preset.accessory} />
        <rect x="42" y="26" width="44" height="5" fill={preset.accent} />
      </>
    );
  }

  if (feature === "bell") {
    return (
      <>
        <rect x="22" y="42" width="8" height="14" fill={preset.bodyDark} />
        <rect x="98" y="42" width="8" height="14" fill={preset.bodyDark} />
        <rect x="59" y="21" width="11" height="7" fill={preset.accent} />
      </>
    );
  }

  if (feature === "bolt") {
    return (
      <>
        <rect x="29" y="20" width="8" height="17" fill={preset.accent} />
        <rect x="91" y="20" width="8" height="17" fill={preset.accent} />
        <rect x="33" y="32" width="8" height="9" fill={preset.bodyTop} />
        <rect x="87" y="32" width="8" height="9" fill={preset.bodyTop} />
      </>
    );
  }

  if (feature === "star") {
    return (
      <>
        <rect x="60" y="13" width="8" height="24" fill={preset.accessory} />
        <rect x="52" y="21" width="24" height="8" fill={preset.accessory} />
        <rect x="56" y="17" width="16" height="16" fill={preset.accessory} />
      </>
    );
  }

  if (feature === "leaf" || feature === "sprout") {
    return (
      <>
        <rect x="61" y="15" width="6" height="18" fill={preset.accent} />
        <rect x="49" y="18" width="16" height="10" fill={preset.accent} />
        <rect x="66" y="18" width="16" height="10" fill={preset.bodyLight} />
      </>
    );
  }

  if (feature === "flame") {
    return (
      <>
        <rect x="58" y="9" width="12" height="20" fill={preset.accessory} />
        <rect x="52" y="18" width="9" height="14" fill={preset.accent} />
        <rect x="69" y="17" width="8" height="15" fill={preset.bodyLight} />
      </>
    );
  }

  if (feature === "fins") {
    return (
      <>
        <rect x="18" y="45" width="10" height="18" fill={preset.accent} />
        <rect x="100" y="45" width="10" height="18" fill={preset.accent} />
        <rect x="55" y="18" width="18" height="10" fill={preset.accessory} />
      </>
    );
  }

  if (feature === "moon") {
    return (
      <>
        <rect x="57" y="14" width="18" height="18" fill={preset.accessory} />
        <rect x="64" y="12" width="15" height="19" fill={preset.bodyTop} />
        <rect x="24" y="37" width="7" height="18" fill={preset.bodyDark} />
        <rect x="97" y="37" width="7" height="18" fill={preset.bodyDark} />
      </>
    );
  }

  if (feature === "mushroom") {
    return (
      <>
        <rect x="31" y="18" width="66" height="22" fill={preset.bodyTop} />
        <rect x="42" y="13" width="44" height="11" fill={preset.bodyTop} />
        <rect x="45" y="22" width="9" height="8" fill={preset.accessory} />
        <rect x="73" y="20" width="10" height="8" fill={preset.accessory} />
      </>
    );
  }

  if (feature === "spin") {
    return (
      <>
        <rect x="47" y="17" width="34" height="9" fill={preset.bodyLight} />
        <rect x="37" y="24" width="14" height="8" fill={preset.bodyLight} />
        <rect x="78" y="24" width="13" height="8" fill={preset.bodyLight} />
        <rect x="29" y="31" width="11" height="7" fill={preset.bodyLight} />
      </>
    );
  }

  if (feature === "chomp") {
    return (
      <>
        <rect x="88" y="48" width="14" height="8" fill={preset.highlight} />
        <rect x="88" y="60" width="14" height="8" fill={preset.highlight} />
      </>
    );
  }

  if (feature === "ghost" || feature === "slime") {
    return (
      <>
        <rect x="44" y="19" width="40" height="12" fill={preset.bodyLight} />
        <rect x="36" y="27" width="56" height="10" fill={preset.bodyLight} />
      </>
    );
  }

  if (feature === "cap" || feature === "straw") {
    return (
      <>
        <rect x="34" y="18" width="58" height="12" fill={feature === "straw" ? preset.accessory : preset.bodyTop} />
        <rect x="45" y="12" width="36" height="10" fill={feature === "straw" ? preset.accessory : preset.bodyTop} />
        <rect x="58" y="22" width="14" height="5" fill={feature === "straw" ? preset.accent : preset.accessory} />
      </>
    );
  }

  if (feature === "bow" || feature === "hood") {
    return (
      <>
        <rect x="76" y="17" width="13" height="13" fill={preset.accent} />
        <rect x="91" y="17" width="13" height="13" fill={preset.accent} />
        <rect x="88" y="21" width="7" height="7" fill={preset.accessory} />
      </>
    );
  }

  if (feature === "mask" || feature === "ninja") {
    return (
      <>
        <rect x="35" y="25" width="58" height="8" fill={preset.accent} />
        <rect x="48" y="18" width="12" height="10" fill={preset.accent} />
        <rect x="69" y="18" width="12" height="10" fill={preset.accent} />
      </>
    );
  }

  if (feature === "soot") {
    return (
      <>
        <rect x="27" y="25" width="8" height="8" fill={preset.bodyLight} />
        <rect x="92" y="23" width="9" height="9" fill={preset.bodyLight} />
        <rect x="61" y="12" width="7" height="7" fill={preset.bodyLight} />
      </>
    );
  }

  if (feature === "pearl" || feature === "wand") {
    return (
      <>
        <rect x="58" y="12" width="13" height="13" fill={preset.accessory} />
        <rect x="61" y="7" width="7" height="7" fill={preset.accent} />
        <rect x="73" y="17" width="9" height="9" fill={preset.accent} />
      </>
    );
  }

  if (feature === "mecha") {
    return (
      <>
        <rect x="29" y="24" width="12" height="13" fill={preset.accent} />
        <rect x="87" y="24" width="12" height="13" fill={preset.accent} />
        <rect x="51" y="18" width="27" height="9" fill={preset.accessory} />
      </>
    );
  }

  if (feature === "ink") {
    return (
      <>
        <rect x="35" y="19" width="12" height="16" fill={preset.accent} />
        <rect x="56" y="14" width="14" height="20" fill={preset.accent} />
        <rect x="80" y="19" width="12" height="16" fill={preset.accent} />
      </>
    );
  }

  if (feature === "drum") {
    return (
      <>
        <rect x="31" y="27" width="66" height="7" fill={preset.accent} />
        <rect x="41" y="18" width="46" height="10" fill={preset.accessory} />
      </>
    );
  }

  return (
    <>
      <rect x="38" y="30" width="10" height="4" fill={preset.bodyLight} />
      <rect x="80" y="30" width="10" height="4" fill={preset.bodyDark} />
    </>
  );
}

function MonsterPresetBodyMarks({
  preset,
}: {
  preset: CloudCodeMonsterPetPreset;
}) {
  const feature = preset.feature as string;

  return (
    <>
      {preset.facePatch ? (
        <>
          <rect x="40" y="39" width="48" height="34" fill={preset.facePatch} />
          <rect x="46" y="73" width="36" height="10" fill={preset.facePatch} />
        </>
      ) : null}
      {feature === "bell" ? (
        <>
          <rect x="50" y="74" width="28" height="6" fill={preset.accent} />
          <rect x="58" y="80" width="13" height="11" fill={preset.accessory} />
          <rect x="61" y="84" width="7" height="3" fill={preset.eye} />
        </>
      ) : null}
      {feature === "bolt" ? (
        <rect x="89" y="76" width="13" height="8" fill={preset.accent} />
      ) : null}
      {feature === "chomp" ? (
        <rect x="72" y="56" width="22" height="16" fill={preset.highlight} />
      ) : null}
      {feature === "ghost" ? (
        <>
          <rect x="28" y="91" width="12" height="8" fill={preset.bodyLight} />
          <rect x="52" y="91" width="12" height="8" fill={preset.bodyLight} />
          <rect x="76" y="91" width="12" height="8" fill={preset.bodyLight} />
        </>
      ) : null}
      {feature === "drum" ? (
        <rect x="31" y="55" width="66" height="8" fill={preset.accessory} />
      ) : null}
      {feature === "mecha" ? (
        <>
          <rect x="41" y="35" width="45" height="6" fill={preset.accent} />
          <rect x="57" y="58" width="14" height="9" fill={preset.accessory} />
        </>
      ) : null}
      {preset.cheek ? (
        <>
          <rect x="36" y="58" width="8" height="7" fill={preset.cheek} />
          <rect x="86" y="58" width="8" height="7" fill={preset.cheek} />
        </>
      ) : null}
    </>
  );
}


function MonsterStaticBody({
  preset,
  activityId,
  animated = false,
  reacting = false,
  shaken = false,
  fainted = false,
  eyeOffset,
}: {
  preset: CloudCodeMonsterPetPreset;
  activityId: CloudCodeMonsterActivityId | null;
  animated?: boolean;
  reacting?: boolean;
  shaken?: boolean;
  fainted?: boolean;
  eyeOffset?: { x: number; y: number };
}) {
  const shape = preset.shape ?? "monster";

  if (shape !== "monster") {
    return (
      <g className={animated ? "cloud-code-monster-pet-character" : undefined}>
        <Suspense fallback={null}>
          <LazyMonsterDirectPixelCharacter
            activityId={activityId}
            preset={preset}
            reacting={reacting}
            shaken={shaken}
            fainted={fainted}
            eyeOffset={eyeOffset}
          />
        </Suspense>
      </g>
    );
  }

  return (
    <g className={animated ? "cloud-code-monster-pet-character" : undefined}>
      <MonsterPresetFeature preset={preset} />
      <rect x="32" y="22" width="64" height="12" fill={preset.bodyTop} />
      <rect x="24" y="34" width="80" height="17" fill={preset.bodyTop} />
      <rect x="16" y="51" width="12" height="24" fill={preset.body} />
      <rect x="24" y="51" width="80" height="41" fill={preset.body} />
      <rect x="100" y="51" width="12" height="24" fill={preset.body} />
      <rect x="16" y="63" width="12" height="12" fill={preset.bodyDark} />
      <rect x="30" y="86" width="68" height="10" fill={preset.bodyDark} />
      <rect x="34" y="34" width="60" height="6" fill={preset.bodyLight} />
      <rect x="24" y="51" width="9" height="35" fill={preset.bodySideLight} />
      <rect x="95" y="51" width="9" height="35" fill={preset.bodySideDark} />
      <MonsterPresetBodyMarks preset={preset} />
      <MonsterEyes
        activityId={activityId}
        preset={preset}
        reacting={reacting}
        shaken={shaken}
        fainted={fainted}
        eyeOffset={eyeOffset}
      />
      <rect x="36" y="69" width="8" height="8" fill={preset.bodyLight} />
      <rect x="84" y="69" width="8" height="8" fill={preset.bodySideDark} />
      <rect
        className="cloud-code-monster-pet-left-foot"
        x="29"
        y="96"
        width="12"
        height="22"
        fill={preset.body}
      />
      <rect
        className="cloud-code-monster-pet-left-foot"
        x="52"
        y="96"
        width="12"
        height="22"
        fill={preset.body}
      />
      <rect
        className="cloud-code-monster-pet-right-foot"
        x="76"
        y="96"
        width="12"
        height="22"
        fill={preset.bodyDark}
      />
      <rect
        className="cloud-code-monster-pet-right-foot"
        x="96"
        y="96"
        width="12"
        height="22"
        fill={preset.bodyDark}
      />
    </g>
  );
}

export function CloudCodeMonsterPresetPreview({
  preset,
  className,
}: {
  preset: CloudCodeMonsterPetPreset;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 128 128"
      role="img"
      aria-label={`${preset.name} pixel PET preset`}
      shapeRendering="crispEdges"
    >
      <rect x="31" y="116" width="66" height="5" fill="rgba(45,40,36,.12)" />
      <rect x="40" y="121" width="48" height="3" fill="rgba(45,40,36,.07)" />
      <MonsterStaticBody preset={preset} activityId={null} />
    </svg>
  );
}

export function MonsterSvg({
  activityId,
  preset,
  reacting,
  shaken,
  fainted,
  eyeOffset,
}: {
  activityId: CloudCodeMonsterActivityId | null;
  preset: CloudCodeMonsterPetPreset;
  reacting: boolean;
  shaken: boolean;
  fainted: boolean;
  eyeOffset?: { x: number; y: number };
}) {
  const expression = getCloudCodeMonsterExpression(
    activityId,
    reacting,
    shaken,
    fainted
  );
  const isShocked = expression === "shocked" || expression === "shaken";

  return (
    <svg
      className="cloud-code-monster-pet-svg"
      viewBox="0 0 128 128"
      role="img"
      aria-label={`Claude Code style pixel monster ${activityId ?? "idle"}`}
      shapeRendering="crispEdges"
    >
      <rect className="cloud-code-monster-pet-shadow cloud-code-monster-pet-shadow-main" x="31" y="116" width="66" height="5" fill="rgba(45,40,36,.14)" />
      <rect className="cloud-code-monster-pet-shadow cloud-code-monster-pet-shadow-soft" x="40" y="121" width="48" height="3" fill="rgba(45,40,36,.08)" />
      {isShocked ? (
        <g className="cloud-code-monster-pet-shock" aria-hidden="true">
          <rect x="17" y="15" width="7" height="17" fill={preset.accent} />
          <rect x="103" y="13" width="7" height="17" fill={preset.accent} />
          <rect x="61" y="4" width="7" height="16" fill={preset.accent} />
          <rect x="19" y="91" width="16" height="6" fill={preset.accessory} />
          <rect x="94" y="91" width="16" height="6" fill={preset.accessory} />
        </g>
      ) : null}
      <MonsterStaticBody
        preset={preset}
        activityId={activityId}
        animated
        reacting={reacting}
        shaken={shaken}
        fainted={fainted}
        eyeOffset={eyeOffset}
      />
      <MonsterActivityAccessory
        activityId={fainted ? null : activityId}
        preset={preset}
      />
    </svg>
  );
}
