import { describe, expect, it } from "vitest";
import { parseDurationMs } from "../src/index.js";

describe("parseDurationMs", () => {
  it("parses seconds, minutes, hours, and days", () => {
    expect(parseDurationMs("45s")).toBe(45_000);
    expect(parseDurationMs("30m")).toBe(30 * 60_000);
    expect(parseDurationMs("24h")).toBe(24 * 3_600_000);
    expect(parseDurationMs("7d")).toBe(7 * 86_400_000);
  });

  it("is case-insensitive on the unit", () => {
    expect(parseDurationMs("24H")).toBe(parseDurationMs("24h"));
  });

  it("tolerates internal whitespace", () => {
    expect(parseDurationMs(" 24 h ")).toBe(24 * 3_600_000);
  });

  it("rejects a malformed window", () => {
    expect(() => parseDurationMs("tomorrow")).toThrow(/invalid duration window/);
    expect(() => parseDurationMs("24")).toThrow(/invalid duration window/);
    expect(() => parseDurationMs("24x")).toThrow(/invalid duration window/);
  });
});
