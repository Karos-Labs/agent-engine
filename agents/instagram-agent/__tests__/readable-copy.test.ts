import { describe, expect, it } from "vitest";
import { lintReadableCopy, readableCopySteer } from "../src/workflow/readable-copy.js";

/** Owner feedback round 2026-09-24 (C, WS-10). Every failing string below shipped on a real prep post. */

const slide = (n: number, headline: string, body = "") => ({ n, headline, body });
const rules = (slides: ReturnType<typeof slide>[], closer?: number) => lintReadableCopy(slides, closer).map((f) => f.rule);

describe("readable copy", () => {
  it("refuses verbless negation fragments", () => {
    expect(rules([slide(2, "The data was there", "Not sentiment. A specific act of memory.")])).toContain("fragment-opener");
    expect(rules([slide(3, "No scope. No autonomy level. No named supervisor.")])).toEqual(expect.arrayContaining(["fragment-opener", "staccato"]));
  });

  it("refuses the 'X is not Y. It is Z.' reveal, in English and Portuguese", () => {
    expect(rules([slide(1, "Wrapped is not Spotify's best campaign. It is Spotify's best data decision.")])).toContain("not-x-it-is-y");
    expect(rules([slide(4, "O teto nao era de capacidade. Era de regra.")])).toContain("not-x-it-is-y");
  });

  it("allows a single ', not X' tail and refuses the second", () => {
    expect(rules([slide(2, "They ship weekly, not quarterly.")])).not.toContain("not-tails");
    expect(rules([slide(2, "They ship weekly, not quarterly."), slide(3, "Teams own outcomes, not tasks.")])).toContain("not-tails");
  });

  it("refuses a sentence repeated on two slides and a long closer", () => {
    expect(rules([slide(1, "Local knowledge sold by locals", "Creators map the city for you."), slide(6, "Your next trip", "Creators map the city for you.")])).toContain("repeated-sentence");
    expect(rules([slide(8, "What will you try first?", "Is it the thong? Is it the bralette? Tell us which one you would pick and why it matters to you today.")], 8)).toContain("closer-length");
  });

  it("passes complete, positive sentences", () => {
    const clean = [
      slide(1, "Spotify's best campaign started as a data decision", "Half a billion shares came from one record of what people played."),
      slide(2, "The team kept every listening log", "That archive became the story each listener received in December."),
      slide(3, "Which of these will you try first?", ""),
    ];
    expect(lintReadableCopy(clean, 3)).toEqual([]);
  });

  it("names every finding at once for the reviser", () => {
    const steer = readableCopySteer(lintReadableCopy([slide(2, "Not sentiment. A specific act of memory.")]));
    expect(steer).toContain("complete sentences");
    expect(steer).toContain('slide 2 "Not sentiment"');
  });
});
