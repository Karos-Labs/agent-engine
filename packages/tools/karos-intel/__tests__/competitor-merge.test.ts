import { describe, expect, it } from "vitest";
import { mergeCompetitors } from "../src/competitor-merge.js";
import type { ClientCompetitor, PersistedClientCompetitor } from "../src/types.js";

/**
 * Regression coverage for Fix 2 (P0): legacy's real `replaceReportCompetitors`
 * merge/dedup behavior (`karosCMO/src/lib/data.ts` lines 1575-1660), ported in
 * `competitor-merge.ts`. Before this fix, `write-report.ts` did a plain
 * `[...manualRows, ...reportRows]` concatenation with no identity matching at
 * all — every one of these cases would have duplicated or lost data.
 */
function reportRow(overrides: Partial<ClientCompetitor> = {}): ClientCompetitor {
  return {
    company: "Rival Corp",
    marketTier: "Challenger",
    overlap: "Medium",
    deepDive: false,
    keyStrengths: [],
    keyWeaknesses: [],
    source: "report",
    ...overrides,
  };
}

describe("mergeCompetitors (Fix 2: real composite-key dedup/merge, port of legacy replaceReportCompetitors)", () => {
  it("(a) the same competitor (matched by domain) across two consecutive regenerations does not duplicate — it is enriched/updated instead", () => {
    const firstRun = mergeCompetitors([], [reportRow({ company: "Rival Corp", url: "rivalcorp.com", overlap: "Medium" })]);
    expect(firstRun).toHaveLength(1);

    const secondRun = mergeCompetitors(
      firstRun,
      [reportRow({ company: "Rival Corp", url: "rivalcorp.com", overlap: "High", positioning: "Now the category leader" })],
    );

    expect(secondRun).toHaveLength(1);
    expect(secondRun[0]!.company).toBe("Rival Corp");
    expect(secondRun[0]!.overlap).toBe("High");
    expect(secondRun[0]!.positioning).toBe("Now the category leader");
    expect(secondRun[0]!.source).toBe("report");
  });

  it("(a) llmMentions measured on an old report row is carried forward across the regeneration that replaces it", () => {
    const existing: PersistedClientCompetitor[] = [
      { ...reportRow({ company: "Rival Corp", url: "rivalcorp.com" }), llmMentions: 7, llmMentionsAt: 1700000000000 },
    ];
    const result = mergeCompetitors(existing, [reportRow({ company: "Rival Corp", url: "rivalcorp.com" })]);

    expect(result).toHaveLength(1);
    expect(result[0]!.llmMentions).toBe(7);
    expect(result[0]!.llmMentionsAt).toBe(1700000000000);
  });

  it("(b) a manually-tracked competitor whose domain matches a freshly-surfaced report competitor gets enriched, never duplicated", () => {
    const existing: PersistedClientCompetitor[] = [
      {
        company: "Rival Corp",
        url: "rivalcorp.com",
        founded: "2019",
        scale: "Series B, ~80 employees",
        marketTier: "Niche",
        overlap: "Low",
        deepDive: false,
        keyStrengths: ["Strong support team"],
        keyWeaknesses: [],
        source: "manual",
      },
    ];
    const incoming = [
      reportRow({
        company: "Rival Corp",
        url: "rivalcorp.com",
        marketTier: "Leader",
        overlap: "High",
        positioning: "Owns the enterprise segment",
        keyStrengths: ["Enterprise SSO", "24/7 support"],
        threatLevel: "HIGH",
      }),
    ];

    const result = mergeCompetitors(existing, incoming);

    expect(result).toHaveLength(1); // never duplicated into a second "report" twin
    const row = result[0]!;
    expect(row.source).toBe("manual"); // stays manual — never flipped to "report"
    // Fields the incoming report row always overwrites:
    expect(row.marketTier).toBe("Leader");
    expect(row.overlap).toBe("High");
    // Fields overwritten only because the incoming row had a non-empty value:
    expect(row.positioning).toBe("Owns the enterprise segment");
    expect(row.keyStrengths).toEqual(["Enterprise SSO", "24/7 support"]);
    expect(row.threatLevel).toBe("HIGH");
    // Fields legacy never touches on a manual-row enrichment — human-set data survives untouched:
    expect(row.founded).toBe("2019");
    expect(row.scale).toBe("Series B, ~80 employees");
  });

  it("(b) a manual row's placeholder company (a raw pasted URL) is replaced once the report supplies a real name; a real manual name is preserved", () => {
    const existingPlaceholder: PersistedClientCompetitor[] = [
      {
        company: "https://rivalcorp.com",
        marketTier: "Other",
        overlap: "Low",
        deepDive: false,
        keyStrengths: [],
        keyWeaknesses: [],
        source: "manual",
      },
    ];
    const resultPlaceholder = mergeCompetitors(existingPlaceholder, [reportRow({ company: "Rival Corp", url: "rivalcorp.com" })]);
    expect(resultPlaceholder[0]!.company).toBe("Rival Corp");

    const existingRealName: PersistedClientCompetitor[] = [
      {
        company: "Rival Corp International",
        url: "rivalcorp.com",
        marketTier: "Other",
        overlap: "Low",
        deepDive: false,
        keyStrengths: [],
        keyWeaknesses: [],
        source: "manual",
      },
    ];
    const resultRealName = mergeCompetitors(existingRealName, [reportRow({ company: "Rival Corp", url: "rivalcorp.com" })]);
    expect(resultRealName[0]!.company).toBe("Rival Corp International"); // the human's real name is not clobbered
  });

  it("(b) a manual row with no url gets one filled in from the matching incoming report row (matched by normalized name)", () => {
    const existing: PersistedClientCompetitor[] = [
      {
        company: "Rival Corp",
        marketTier: "Other",
        overlap: "Low",
        deepDive: false,
        keyStrengths: [],
        keyWeaknesses: [],
        source: "manual",
      },
    ];
    const result = mergeCompetitors(existing, [reportRow({ company: "Rival Corp", url: "rivalcorp.com" })]);
    expect(result[0]!.url).toBe("rivalcorp.com");
  });

  it("(c) a genuinely new competitor (no key match at all) is appended, not merged into an unrelated existing row", () => {
    const existing: PersistedClientCompetitor[] = [
      { company: "Manual Co", url: "manualco.com", marketTier: "Niche", overlap: "Low", deepDive: false, keyStrengths: [], keyWeaknesses: [], source: "manual" },
    ];
    const incoming = [
      reportRow({ company: "Rival Corp", url: "rivalcorp.com" }), // brand new — shares no key with Manual Co
    ];

    const result = mergeCompetitors(existing, incoming);

    expect(result).toHaveLength(2);
    const manual = result.find((r) => r.company === "Manual Co")!;
    const rival = result.find((r) => r.company === "Rival Corp")!;
    expect(manual).toBeTruthy();
    expect(manual.source).toBe("manual");
    expect(manual.marketTier).toBe("Niche"); // completely untouched by the unrelated incoming row
    expect(rival).toBeTruthy();
    expect(rival.source).toBe("report");
  });

  it("an old report row unmatched this run, with real measured llmMentions and no manual coverage, survives instead of being silently dropped", () => {
    const existing: PersistedClientCompetitor[] = [
      { ...reportRow({ company: "Ghost Rival", url: "ghostrival.com" }), llmMentions: 3 },
    ];
    // This run's fresh parse doesn't re-surface Ghost Rival at all.
    const result = mergeCompetitors(existing, [reportRow({ company: "Someone Else", url: "someoneelse.com" })]);

    expect(result.some((r) => r.company === "Ghost Rival")).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("an old report row unmatched this run with NO measured llmMentions is dropped (every report row is replaced on regeneration)", () => {
    const existing: PersistedClientCompetitor[] = [reportRow({ company: "Ghost Rival", url: "ghostrival.com" })];
    const result = mergeCompetitors(existing, [reportRow({ company: "Someone Else", url: "someoneelse.com" })]);

    expect(result.some((r) => r.company === "Ghost Rival")).toBe(false);
    expect(result).toHaveLength(1);
  });

  it("an unmatched old report row with measured llmMentions is dropped anyway once a manual row now covers the same identity", () => {
    const existing: PersistedClientCompetitor[] = [
      { ...reportRow({ company: "Ghost Rival", url: "ghostrival.com" }), llmMentions: 3 },
      { company: "Ghost Rival Manual", url: "ghostrival.com", marketTier: "Niche", overlap: "Low", deepDive: false, keyStrengths: [], keyWeaknesses: [], source: "manual" },
    ];
    const result = mergeCompetitors(existing, [reportRow({ company: "Someone Else", url: "someoneelse.com" })]);

    // The manual row (same domain) now covers this identity, so the old measured "report"
    // twin does not also survive as a separate row.
    expect(result.filter((r) => r.url === "ghostrival.com")).toHaveLength(1);
    expect(result.find((r) => r.url === "ghostrival.com")!.source).toBe("manual");
  });

  it("matches purely by normalized company name when neither row has a url", () => {
    const existing: PersistedClientCompetitor[] = [
      { company: "Acme Consulting Group", marketTier: "Other", overlap: "Low", deepDive: false, keyStrengths: [], keyWeaknesses: [], source: "manual", positioning: "Old note" },
    ];
    // "Acme Consulting Group" and "ACME" normalize to the same key once generic
    // agency-suffix words are stripped (see competitor-keys.ts's normalizeBrandKey).
    const result = mergeCompetitors(existing, [reportRow({ company: "ACME", overlap: "High" })]);

    expect(result).toHaveLength(1);
    expect(result[0]!.overlap).toBe("High");
    expect(result[0]!.positioning).toBe("Old note"); // incoming had no positioning — preserved
  });
});
