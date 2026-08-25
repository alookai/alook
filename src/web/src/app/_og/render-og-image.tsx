import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { BRAND_SLOGAN } from "@/lib/brand-copy";
import {
  normalizeOgTitle,
  OG_TITLE_FONT_SIZE,
  OG_TITLE_LINE_CLAMP,
  OG_TITLE_MAX_HEIGHT,
} from "./og-title";

export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const;
export const OG_IMAGE_CONTENT_TYPE = "image/png";

const processRoot = process.cwd();
const webRoot = processRoot.endsWith(join("src", "web"))
  ? processRoot
  : join(processRoot, "src", "web");

const assetsPromise = Promise.all([
  readFile(join(webRoot, "public/icon-192.png")),
  readFile(join(webRoot, "src/app/fonts/dm-sans-600.ttf")),
]);

function TypewriterIllustration() {
  const keyRows = [9, 7, 9];

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: 260,
          padding: "20px 24px",
          background: "#f5f0e8",
          borderRadius: "4px 4px 0 0",
          border: "1px solid #e0d9cc",
          marginBottom: -2,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            borderBottom: "1px solid #d5cec0",
            paddingBottom: 10,
            marginBottom: 10,
          }}
        >
          <div style={{ display: "flex", fontSize: 11, color: "#8a7e6e", marginBottom: 4 }}>
            HOME / FAMILY-PLANS
          </div>
          <div style={{ display: "flex", fontSize: 11, color: "#8a7e6e", marginBottom: 4 }}>
            Maya joined the room.
          </div>
          <div style={{ display: "flex", fontSize: 11, color: "#8a7e6e" }}>
            A note for Alli#8145
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 12, color: "#8a7e6e", lineHeight: 1.5 }}>
          Maya and Alli now share this channel. Gus can catch up when he returns.
        </div>
      </div>

      <div
        style={{
          display: "flex",
          width: 280,
          height: 14,
          background: "#2a231a",
          borderRadius: 7,
        }}
      />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: 320,
          padding: "16px 20px 24px",
          background: "#3d3428",
          borderRadius: 8,
          marginTop: -4,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
          {keyRows.map((count, rowIndex) => (
            <div
              key={rowIndex}
              style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}
            >
              {Array.from({ length: count }).map((_, keyIndex) => (
                <div
                  key={keyIndex}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 11,
                    background: "#b8a98e",
                    border: "1px solid #8a7e6e",
                    marginRight: keyIndex < count - 1 ? 6 : 0,
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export async function renderOgImage(rawTitle: string): Promise<ImageResponse> {
  const title = normalizeOgTitle(rawTitle) || BRAND_SLOGAN;
  const [logoData, fontData] = await assetsPromise;
  const logoDataUri = `data:image/png;base64,${logoData.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          background: "linear-gradient(135deg, #f5f0e8 0%, #ddd5c8 100%)",
          fontFamily: '"DM Sans"',
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            position: "absolute",
            left: 80,
            top: 150,
          }}
        >
          <img
            src={logoDataUri}
            width={120}
            height={120}
            alt=""
            style={{ borderRadius: 28, marginRight: 24 }}
          />
          <span style={{ fontSize: 32, fontWeight: 600, color: "#3d3428" }}>alook.ai</span>
        </div>

        <div
          style={{
            display: "flex",
            position: "absolute",
            left: 80,
            top: 310,
            height: OG_TITLE_MAX_HEIGHT,
            width: 600,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "block",
              fontSize: OG_TITLE_FONT_SIZE,
              fontWeight: 600,
              color: "#2a231a",
              lineHeight: 1.15,
              lineClamp: OG_TITLE_LINE_CLAMP,
              width: "100%",
              overflow: "hidden",
              wordBreak: "break-word",
            }}
          >
            {title}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            position: "absolute",
            left: 80,
            top: 450,
            width: 600,
            fontSize: 22,
            color: "#8a7e6e",
          }}
        >
          Bring the agents you already use into a room with people you trust.
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "absolute",
            left: 760,
            top: 168,
            width: 380,
            height: 296,
          }}
        >
          <TypewriterIllustration />
        </div>
      </div>
    ),
    {
      ...OG_IMAGE_SIZE,
      fonts: [
        {
          name: "DM Sans",
          data: Uint8Array.from(fontData).buffer,
          weight: 600,
          style: "normal",
        },
      ],
    },
  );
}
