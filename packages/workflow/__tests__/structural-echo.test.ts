import { describe, expect, it } from "vitest";
import { historyShapeEchoes, structuralEchoDirective, structuralEchoLine, structuralEchoes, structuralSignature } from "../src/primitives/structural-echo.js";
import type { DedupeHistoryEntry } from "@agent-engine/core";

/**
 * The repetition lexical de-duplication cannot see (2026-09-21 audit).
 *
 * `evaluateDedupe` scores trigram overlap and this fleet passes it comfortably
 * — while five of five TikTok posts for one client were one paragraph, one
 * line and exactly four hashtags, with three closing on an identical sentence;
 * five of five LinkedIn posts carried the same CTA verbatim; and three of five
 * Instagram posts opened on "Most" or "Founders".
 *
 * None of that moves a word-overlap score. The shape is what a reader learns.
 */

function entry(excerpt: string, n: number): DedupeHistoryEntry {
  return { runId: `run-${n}`, excerpt } as DedupeHistoryEntry;
}

/** The TikTok shape the audit measured: one paragraph, one line, four hashtags. */
function tiktokPost(body: string): string {
  return `${body} #marketing #ai #founders #growth`;
}

describe("structuralSignature", () => {
  it("reads the five things that repeat", () => {
    const sig = structuralSignature("Most founders get this wrong.\n\nHere is the fix.\nIt takes a week.\n\n#growth #ai");
    expect(sig.paragraphs).toBe(3);
    expect(sig.lines).toBe(4);
    expect(sig.hashtags).toBe(2);
    expect(sig.opening).toBe("most");
    // The trailing hashtag-only line is not the closing sentence.
    expect(sig.closing).toBe("it takes a week");
  });

  it("counts a Hebrew hashtag, because this product publishes in Hebrew", () => {
    expect(structuralSignature("שלוש דרכים לשפר #שיווק #דיגיטל").hashtags).toBe(2);
  });

  it("does not mistake a markdown heading for a hashtag", () => {
    expect(structuralSignature("# Heading\n\nBody text.").hashtags).toBe(0);
  });

  it("is safe on empty text rather than throwing inside a drafting step", () => {
    expect(structuralSignature("   ")).toEqual({ paragraphs: 0, lines: 0, hashtags: 0, opening: "", closing: "" });
  });
});

describe("structuralEchoes", () => {
  it("catches the four-hashtag template that trigram overlap scores as fine", () => {
    // Deliberately different words every time — this history would pass
    // `evaluateDedupe`, and it is exactly what the audit found.
    const history = [
      entry(tiktokPost("Retention beats acquisition every quarter."), 1),
      entry(tiktokPost("Your pricing page is the real funnel."), 2),
      entry(tiktokPost("Cold email is not dead, your list is."), 3),
      entry(tiktokPost("Hiring a generalist first is usually right."), 4),
    ];

    const echoes = structuralEchoes(tiktokPost("Nobody reads your case studies."), history);
    const dims = echoes.map((e) => e.dimension);

    expect(dims).toContain("hashtags");
    expect(dims).toContain("paragraphs");
    expect(dims).toContain("lines");
    expect(echoes.find((e) => e.dimension === "hashtags")).toMatchObject({ value: "4", matched: 4, of: 4 });
  });

  it("catches an opening the client keeps reusing, keyed on the first word", () => {
    // The SECOND word differs every time, which is exactly why the dimension
    // is the first word alone: a two-word key matches none of these and
    // reports the client clean.
    const history = [
      entry("Most founders overvalue their seed deck.", 1),
      entry("Most investors skim the first slide only.", 2),
      entry("Most decks bury the number that matters.", 3),
    ];

    const echoes = structuralEchoes("Most teams write for the wrong reader.", history);
    expect(echoes.find((e) => e.dimension === "opening")).toMatchObject({ value: "most", matched: 3, of: 3 });
  });

  it("catches an identical closing line", () => {
    const close = "Book a call if that sounds familiar.";
    const history = [
      entry(`Alpha point made here. ${close}`, 1),
      entry(`Beta point, different words. ${close}`, 2),
      entry(`Gamma point, another thing. ${close}`, 3),
    ];

    expect(structuralEchoes(`Delta point, something new. ${close}`, history).map((e) => e.dimension)).toContain("closing");
  });

  it("says nothing at all on too little history, rather than reporting all clear", () => {
    // A new client has no shape yet. Two posts that rhyme are two posts.
    expect(structuralEchoes(tiktokPost("x"), [entry(tiktokPost("a"), 1), entry(tiktokPost("b"), 2)])).toEqual([]);
    expect(structuralEchoes("anything", [])).toEqual([]);
  });

  it("leaves a genuinely varied history alone", () => {
    // Varied in every dimension the signature reads — including paragraph
    // count, which an earlier version of this fixture held at 1 throughout and
    // which the scorer was right to flag.
    const history = [
      entry("One line only.", 1),
      entry("Two paragraphs.\n\nSecond one here, longer. #a #b #c", 2),
      entry("A\nB\nC\nD\nE #one", 3),
      entry("Alpha block.\n\nBeta block.\n\nGamma block ends here.", 4),
    ];

    expect(structuralEchoes("Fresh opener here.\n\nAnd a different close. #solo", history)).toEqual([]);
  });

  it("does not report an empty opening or closing as a repetition", () => {
    // Absence is not a template. Three empty posts must not make "" an echo.
    const history = [entry("   ", 1), entry("   ", 2), entry("   ", 3)];
    const dims = structuralEchoes("   ", history).map((e) => e.dimension);
    expect(dims).not.toContain("opening");
    expect(dims).not.toContain("closing");
  });
});

describe("the steer and the reviewer line", () => {
  it("names what to change, not just that something repeats", () => {
    const history = [entry(tiktokPost("a"), 1), entry(tiktokPost("b"), 2), entry(tiktokPost("c"), 3)];
    const directive = structuralEchoDirective(structuralEchoes(tiktokPost("d"), history));

    expect(directive).toBeDefined();
    expect(directive).toMatch(/exactly 4 hashtag/);
    expect(directive).toMatch(/Vary the structure, not just the words/);
  });

  it("returns undefined when nothing repeats, so an unaffected prompt is byte-identical", () => {
    // The contract `dedupeDirective` and `revisionDirective` both keep.
    expect(structuralEchoDirective([])).toBeUndefined();
    expect(structuralEchoLine([])).toBeUndefined();
  });

  it("gives the reviewer one line, with the counts", () => {
    const history = [entry(tiktokPost("a"), 1), entry(tiktokPost("b"), 2), entry(tiktokPost("c"), 3)];
    expect(structuralEchoLine(structuralEchoes(tiktokPost("d"), history))).toMatch(/hashtags \(3\/3\)/);
  });
});

describe("historyShapeEchoes — the form that actually fires", () => {
  it("finds the template from the history alone, with no draft to compare", () => {
    // The reason this exists: `structuralEchoes` needs a draft, and the only
    // place a draft is compared today is the de-duplication retry loop, which
    // triggers on LEXICAL similarity — the one thing these posts do not have.
    // Five different-worded posts with an identical shape never reach it.
    const history = [
      entry(tiktokPost("Retention beats acquisition every quarter."), 1),
      entry(tiktokPost("Your pricing page is the real funnel."), 2),
      entry(tiktokPost("Cold email is not dead, your list is."), 3),
    ];

    const echoes = historyShapeEchoes(history);
    expect(echoes.map((e) => e.dimension)).toContain("hashtags");
    expect(echoes.find((e) => e.dimension === "hashtags")).toMatchObject({ value: "4", matched: 3, of: 3 });
  });

  it("finds a repeated opening even when no single post is the draft", () => {
    const history = [
      entry("Most founders overvalue their seed deck.", 1),
      entry("Most investors skim the first slide only.", 2),
      entry("Most decks bury the number that matters.", 3),
    ];
    expect(historyShapeEchoes(history).find((e) => e.dimension === "opening")).toMatchObject({ value: "most", matched: 3 });
  });

  it("says nothing for a client with no template, so their prompt is unchanged", () => {
    const history = [
      entry("One line only.", 1),
      entry("Two paragraphs.\n\nSecond one here, longer. #a #b #c", 2),
      entry("A\nB\nC\nD\nE #one", 3),
      entry("Alpha block.\n\nBeta block.\n\nGamma block ends here.", 4),
    ];
    expect(historyShapeEchoes(history)).toEqual([]);
    expect(structuralEchoDirective(historyShapeEchoes(history))).toBeUndefined();
  });

  it("says nothing on too little history", () => {
    expect(historyShapeEchoes([entry(tiktokPost("a"), 1), entry(tiktokPost("b"), 2)])).toEqual([]);
    expect(historyShapeEchoes([])).toEqual([]);
  });

  it("does not let an absent opening or closing become the template", () => {
    const history = [entry("   ", 1), entry("   ", 2), entry("   ", 3)];
    const dims = historyShapeEchoes(history).map((e) => e.dimension);
    expect(dims).not.toContain("opening");
    expect(dims).not.toContain("closing");
  });
});
