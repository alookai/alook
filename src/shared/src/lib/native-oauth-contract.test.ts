import { describe, expect, it } from "vitest";
import {
  NATIVE_OAUTH_FAILURE_CODES,
  NATIVE_OAUTH_PLATFORMS,
  NATIVE_OAUTH_PROVIDERS,
} from "../db/schema";
import {
  nativeOauthFailureCodeSchema,
  nativeOauthPlatformSchema,
  nativeOauthProviderSchema,
} from "./native-oauth-contract";

describe("native OAuth contract drift", () => {
  it("keeps request schemas aligned with persisted enum values", () => {
    expect(nativeOauthProviderSchema.options).toEqual([
      ...NATIVE_OAUTH_PROVIDERS,
    ]);
    expect(nativeOauthPlatformSchema.options).toEqual([
      ...NATIVE_OAUTH_PLATFORMS,
    ]);
    expect(nativeOauthFailureCodeSchema.options).toEqual([
      ...NATIVE_OAUTH_FAILURE_CODES,
    ]);
  });
});
