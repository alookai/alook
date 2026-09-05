import { describe, expect, it } from "vitest";
import * as queries from "./queries-index";
import * as nativeOauth from "./queries/native-oauth";

describe("query barrel", () => {
  it("exposes the canonical native OAuth query module", () => {
    expect(queries.nativeOauth.registerAttempt).toBe(nativeOauth.registerAttempt);
    expect(queries.nativeOauth.claimExchange).toBe(nativeOauth.claimExchange);
    expect(queries.nativeOauth.finishExchange).toBe(nativeOauth.finishExchange);
    expect(queries.nativeOauth.getAttemptStatus).toBe(nativeOauth.getAttemptStatus);
  });
});
