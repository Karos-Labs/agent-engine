import { describe, expect, it } from "vitest";
import { designLanguageAction, readDesignLanguage, type StoredDesignLanguage } from "../src/workflow/design-language.js";

const now = new Date("2026-09-25T12:00:00Z");
const measured = (daysAgo: number): StoredDesignLanguage => ({
  version: 1,
  measuredAt: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
  status: "measured",
  url: "https://karoslabs.com",
  tokens: { boxStyle: "hairline", boxRadius: 6, pillButtons: false, lineColor: "rgb(52, 52, 59)", shadowShare: 0, gradientShare: 0 },
  evidence: { cards: 6, buttons: 3 },
});

describe("when the design language is measured (WS-04)", () => {
  it("reuses a fresh measurement, re-measures a stale one, waits a week after a failure", () => {
    expect(designLanguageAction(undefined, now)).toBe("measure");
    expect(designLanguageAction(measured(10), now)).toBe("reuse");
    expect(designLanguageAction(measured(95), now)).toBe("measure");
    const failed: StoredDesignLanguage = { version: 1, measuredAt: new Date(now.getTime() - 2 * 86_400_000).toISOString(), status: "failed", problem: "bot wall" };
    expect(designLanguageAction(failed, now)).toBe("wait");
    expect(designLanguageAction({ ...failed, measuredAt: new Date(now.getTime() - 8 * 86_400_000).toISOString() }, now)).toBe("measure");
  });

  it("reads back only a well-formed record", () => {
    expect(readDesignLanguage(measured(1))?.tokens?.boxStyle).toBe("hairline");
    expect(readDesignLanguage({ version: 1, measuredAt: "x", status: "measured" })).toBeUndefined();
    expect(readDesignLanguage("nope")).toBeUndefined();
  });
});
