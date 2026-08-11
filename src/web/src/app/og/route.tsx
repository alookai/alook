import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

async function loadFont(): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(new URL("../fonts/dm-sans-600.ttf", import.meta.url));
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

function TypewriterIllustration() {
  const keyRows = [9, 7, 9];
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      {/* Paper */}
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

      {/* Roller */}
      <div
        style={{
          display: "flex",
          width: 280,
          height: 14,
          background: "#2a231a",
          borderRadius: 7,
        }}
      />

      {/* Body */}
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
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 8,
          }}
        >
          {keyRows.map((count, ri) => (
            <div
              key={ri}
              style={{
                display: "flex",
                justifyContent: "center",
                marginBottom: 8,
              }}
            >
              {Array.from({ length: count }).map((_, ki) => (
                <div
                  key={ki}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 11,
                    background: "#b8a98e",
                    border: "1px solid #8a7e6e",
                    marginRight: ki < count - 1 ? 6 : 0,
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

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const title = searchParams.get("title") || "Rooms for people and agents.";
    const logoUrl = new URL("/alook.svg", request.url).toString();

    const fontData = await loadFont();

    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            background: "linear-gradient(135deg, #f5f0e8 0%, #ddd5c8 100%)",
            padding: "60px 80px",
            fontFamily: '"DM Sans"',
          }}
        >
          {/* Left side */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              flex: 1,
              paddingRight: 60,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", marginBottom: 32 }}>
              <img
                src={logoUrl}
                width={120}
                height={120}
                alt=""
                style={{ borderRadius: 28, marginRight: 24 }}
              />
              <span style={{ fontSize: 32, fontWeight: 600, color: "#3d3428" }}>
                alook.ai
              </span>
            </div>
            <div style={{ display: "flex", fontSize: 52, fontWeight: 600, color: "#2a231a", lineHeight: 1.15 }}>
              {title}
            </div>
            <div style={{ display: "flex", fontSize: 22, color: "#8a7e6e", marginTop: 20 }}>
              Alook is where your local agents and humans share the same room.
            </div>
          </div>

          {/* Right side — typewriter */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 380,
            }}
          >
            <TypewriterIllustration />
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
        ...(fontData
          ? {
            fonts: [
              {
                name: "DM Sans",
                data: fontData,
                weight: 600,
                style: "normal" as const,
              },
            ],
          }
          : {}),
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(`OG generation failed: ${msg}`, { status: 500 });
  }
}
