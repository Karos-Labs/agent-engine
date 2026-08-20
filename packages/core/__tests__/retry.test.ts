import { describe, expect, it, vi } from "vitest";
import { isRetryableError, withRetry } from "../src/router/adapters/retry.js";

const noDelay = () => Promise.resolve();

describe("isRetryableError", () => {
  it("treats HTTP 429 as retryable", () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
  });

  it("treats any 5xx as retryable", () => {
    expect(isRetryableError({ status: 500 })).toBe(true);
    expect(isRetryableError({ status: 503 })).toBe(true);
    expect(isRetryableError({ status: 599 })).toBe(true);
  });

  it("does not treat a 4xx client error (other than 429) as retryable", () => {
    expect(isRetryableError({ status: 400 })).toBe(false);
    expect(isRetryableError({ status: 401 })).toBe(false);
    expect(isRetryableError({ status: 404 })).toBe(false);
  });

  it("treats a network-level error code as retryable", () => {
    expect(isRetryableError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableError({ code: "ETIMEDOUT" })).toBe(true);
  });

  it("treats an SDK connection/timeout error class (by name, no status at all) as retryable", () => {
    class APIConnectionTimeoutError extends Error {}
    expect(isRetryableError(new APIConnectionTimeoutError("timed out"))).toBe(true);
  });

  it("follows a wrapped .cause to find the real retryable signal", () => {
    const networkError = { code: "ECONNRESET" };
    expect(isRetryableError(new Error("fetch failed", { cause: networkError }))).toBe(true);
  });

  it("does not treat an ordinary application error as retryable", () => {
    expect(isRetryableError(new Error("schema validation failed"))).toBe(false);
    expect(isRetryableError("a plain string")).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns the result immediately on a first-attempt success, with no delay", async () => {
    const delay = vi.fn();
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { delay });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it("retries a transient 429 and succeeds on the second attempt", async () => {
    const delay = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValueOnce({ status: 429 }).mockResolvedValueOnce("ok");
    const result = await withRetry(fn, { delay });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledOnce();
  });

  it("backs off exponentially across attempts", async () => {
    const delay = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValueOnce({ status: 500 }).mockRejectedValueOnce({ status: 500 }).mockResolvedValueOnce("ok");
    const result = await withRetry(fn, { delay, maxAttempts: 3, baseDelayMs: 100 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenNthCalledWith(1, 100);
    expect(delay).toHaveBeenNthCalledWith(2, 200);
  });

  it("gives up after maxAttempts (default 3) and rethrows the last error", async () => {
    const delay = vi.fn().mockResolvedValue(undefined);
    const err = { status: 503 };
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { delay })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it("never retries a non-retryable error, even on the very first attempt", async () => {
    const delay = vi.fn();
    const err = { status: 400 };
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { delay })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it("respects an injected maxAttempts of 1 (no retries at all)", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 429 });
    await expect(withRetry(fn, { delay: noDelay, maxAttempts: 1 })).rejects.toEqual({ status: 429 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
