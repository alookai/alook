import {
  isNativeOauthReturnHost,
  nativeOauthJson,
} from "@/lib/native-oauth";

const association = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "ai.alook.android",
      sha256_cert_fingerprints: [
        "9D:C6:ED:E9:4B:A6:63:EE:C9:EC:98:FF:7B:AF:D5:5E:24:8B:6C:4B:C2:15:7F:CF:04:2D:F5:9B:0E:41:08:06",
      ],
    },
  },
];

export async function GET(request: Request): Promise<Response> {
  if (!isNativeOauthReturnHost(new URL(request.url))) {
    return nativeOauthJson({ error: "not_found" }, { status: 404 });
  }
  return nativeOauthJson(association);
}
