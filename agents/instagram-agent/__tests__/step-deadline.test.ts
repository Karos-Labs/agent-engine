import { describe, expect, it, vi } from "vitest";
import { SOURCE_IMAGES_DEADLINE_MS, withinDeadline } from "../src/workflow/step-deadline.js";

describe("withinDeadline (prep batch 8: a 50-minute hung 05b-source-images)", () => {
  it("answers with the call's own result when it finishes in time", async () => {
    await expect(withinDeadline(Promise.resolve("done"), 1000, () => "late")).resolves.toBe("done");
  });

  it("answers with the timeout result when the call never settles", async () => {
    vi.useFakeTimers();
    try {
      const pending = withinDeadline(new Promise<string>(() => {}), SOURCE_IMAGES_DEADLINE_MS, () => "late");
      await vi.advanceTimersByTimeAsync(SOURCE_IMAGES_DEADLINE_MS);
      await expect(pending).resolves.toBe("late");
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a rejection through rather than hiding it behind the deadline", async () => {
    await expect(withinDeadline(Promise.reject(new Error("boom")), 1000, () => "late")).rejects.toThrow("boom");
  });

  it("is generous against the measured step (max 41s over 68 steps)", () => {
    expect(SOURCE_IMAGES_DEADLINE_MS).toBeGreaterThanOrEqual(4 * 41_000);
  });
});
