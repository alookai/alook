import { NextResponse } from "next/server";

// Replace TEAM_ID with your Apple Developer Team ID after enrollment
const APPLE_APP_SITE_ASSOCIATION = {
  applinks: {
    apps: [],
    details: [
      {
        appIDs: ["TEAM_ID.ai.alook.app"],
        paths: ["*"],
      },
    ],
  },
};

export async function GET() {
  return NextResponse.json(APPLE_APP_SITE_ASSOCIATION, {
    headers: {
      "Content-Type": "application/json",
    },
  });
}
