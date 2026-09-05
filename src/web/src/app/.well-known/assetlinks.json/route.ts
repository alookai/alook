import { NextResponse } from "next/server";

// Replace __PLACEHOLDER__ with the SHA-256 fingerprint of your Android signing certificate
const ASSET_LINKS = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "ai.alook.app",
      sha256_cert_fingerprints: ["__PLACEHOLDER__"],
    },
  },
];

export async function GET() {
  return NextResponse.json(ASSET_LINKS, {
    headers: {
      "Content-Type": "application/json",
    },
  });
}
