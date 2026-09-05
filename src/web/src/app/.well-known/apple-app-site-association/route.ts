import {
  isNativeOauthReturnHost,
  nativeOauthJson,
} from "@/lib/native-oauth";

const association = {
  applinks: {
    apps: [],
    details: [
      {
        appID: "5RF24VHDQB.ai.alook.ios",
        components: [
          {
            "/": "/auth/native/return",
            comment: "Native OAuth handoff return",
          },
        ],
      },
    ],
  },
};

export async function GET(request: Request): Promise<Response> {
  if (!isNativeOauthReturnHost(new URL(request.url))) {
    return nativeOauthJson({ error: "not_found" }, { status: 404 });
  }
  return nativeOauthJson(association);
}
