import { describe, expect, it } from "vitest";
import { generateWithRateLimitRetry } from "../src/inspect-images.js";

/** 1.3.0: a Vertex 429 is the shared quota, not the images. A product campaign fell back on one. */
describe("vision calls retry the shared quota", () => {
  it("retries a 429 and returns the answer", async () => {
    let calls = 0;
    const got = await generateWithRateLimitRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error('{"error":{"code":429,"message":"Resource exhausted. Please try again later."}}');
      return "ok";
    }, 0);
    expect(got).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after three retries and never retries other errors", async () => {
    let calls = 0;
    await expect(generateWithRateLimitRetry(async () => { calls += 1; throw new Error("RESOURCE_EXHAUSTED"); }, 0)).rejects.toThrow("RESOURCE_EXHAUSTED");
    expect(calls).toBe(4);
    let other = 0;
    await expect(generateWithRateLimitRetry(async () => { other += 1; throw new Error("400 invalid argument"); }, 0)).rejects.toThrow("400");
    expect(other).toBe(1);
  });
});
