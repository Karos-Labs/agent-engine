import { describe, expect, it } from "vitest";
import { addressableFields, applyCopyEdits, describeRevision, type CopyRevision } from "../src/workflow/copy-revision.js";
import type { InstagramCopyOutput, InstagramSlideCopy } from "../src/workflow/types.js";

/**
 * The property this buys is not the saving. It is that a retry CANNOT regress
 * what the gates already accepted.
 *
 * On 2026-09-18 every prep run spent its whole attempt budget: attempt 2 fixed
 * the finding and broke something else, attempt 3 fixed that and broke a third
 * thing. The loop was resampling. An edit applied by code to named paths
 * cannot do that, and the tests below are about the paths being resolved
 * against the draft that actually exists rather than against the model's idea
 * of it.
 */

const slide = (n: number, over: Partial<InstagramSlideCopy> = {}): InstagramSlideCopy =>
  ({ n, headline: `Headline ${n}`, body: `Body ${n}.`, sourceRef: "a claim", layout: "photo", visualNeed: "a desk", ...over }) as InstagramSlideCopy;

const draft = (): InstagramCopyOutput =>
  ({
    caption: "The original caption.",
    format: "carousel",
    slides: [
      slide(1),
      slide(3, { items: [{ title: "First", note: "A note" }, { title: "Second" }] }),
      slide(5, { stat: { figure: "30%", subLabel: "of teams", source: "a source" } }),
      slide(6, { quote: { text: "As written", attribution: "Someone" } }),
    ],
  }) as unknown as InstagramCopyOutput;

const revision = (edits: CopyRevision["edits"], kept = "everything else"): CopyRevision => ({ edits, kept });

describe("applyCopyEdits", () => {
  it("changes only the fields it names, and leaves the rest byte-identical", () => {
    const before = draft();
    const { copy, applied, rejected } = applyCopyEdits(before, revision([{ path: "slide.3.headline", text: "A better headline", fixes: "no tension" }]));

    expect(applied).toHaveLength(1);
    expect(rejected).toEqual([]);
    expect(copy.slides.find((s) => s.n === 3)!.headline).toBe("A better headline");
    // THE PROPERTY. Everything else is the object it was.
    expect(copy.caption).toBe(before.caption);
    expect(copy.slides.find((s) => s.n === 1)).toEqual(before.slides.find((s) => s.n === 1));
    expect(copy.slides.find((s) => s.n === 5)).toEqual(before.slides.find((s) => s.n === 5));
    expect(copy.slides.find((s) => s.n === 6)).toEqual(before.slides.find((s) => s.n === 6));
    // …and the input was not mutated.
    expect(before.slides.find((s) => s.n === 3)!.headline).toBe("Headline 3");
  });

  it("reaches every addressable kind of field", () => {
    const { copy, rejected } = applyCopyEdits(
      draft(),
      revision([
        { path: "caption", text: "A new caption", fixes: "dash" },
        { path: "slide.1.body", text: "A new body", fixes: "opening" },
        { path: "slide.3.items.2.title", text: "Second, revised", fixes: "repeat" },
        { path: "slide.3.items.1.note", text: "A better note", fixes: "repeat" },
        { path: "slide.5.stat.subLabel", text: "of the teams measured", fixes: "quote" },
        { path: "slide.6.quote.text", text: "As revised", fixes: "quote" },
      ]),
    );
    expect(rejected).toEqual([]);
    expect(copy.caption).toBe("A new caption");
    expect(copy.slides.find((s) => s.n === 1)!.body).toBe("A new body");
    expect(copy.slides.find((s) => s.n === 3)!.items![1]!.title).toBe("Second, revised");
    expect(copy.slides.find((s) => s.n === 3)!.items![0]!.note).toBe("A better note");
    expect(copy.slides.find((s) => s.n === 5)!.stat!.subLabel).toBe("of the teams measured");
    expect(copy.slides.find((s) => s.n === 6)!.quote!.text).toBe("As revised");
  });

  it("addresses slides by their own `n`, which is what a finding names, not by array index", () => {
    // This draft's slides are 1, 3, 5, 6. An implementation that indexed the
    // array would put this edit on slide 6.
    const { copy } = applyCopyEdits(draft(), revision([{ path: "slide.3.body", text: "Edited", fixes: "x" }]));
    expect(copy.slides.find((s) => s.n === 3)!.body).toBe("Edited");
    expect(copy.slides.find((s) => s.n === 6)!.body).toBe("Body 6.");
  });

  it("REFUSES a slide the draft does not carry, rather than growing the post by one nobody wrote", () => {
    const { copy, applied, rejected } = applyCopyEdits(draft(), revision([{ path: "slide.9.headline", text: "Invented", fixes: "x" }]));
    expect(applied).toEqual([]);
    expect(copy.slides).toHaveLength(4);
    expect(rejected[0]!.reason).toContain("not in this draft");
    expect(rejected[0]!.reason).toContain("1, 3, 5, 6");
  });

  it("refuses a field the archetype does not have, and says which", () => {
    const { rejected } = applyCopyEdits(
      draft(),
      revision([
        { path: "slide.1.stat.subLabel", text: "x", fixes: "y" },
        { path: "slide.1.quote.text", text: "x", fixes: "y" },
        { path: "slide.3.items.9.title", text: "x", fixes: "y" },
      ]),
    );
    expect(rejected.map((r) => r.reason)).toEqual([
      expect.stringContaining("carries no stat"),
      expect.stringContaining("carries no quote"),
      expect.stringContaining("2 item(s)"),
    ]);
  });

  it("refuses a path that is not a field at all, and refuses to blank one that is", () => {
    const { applied, rejected } = applyCopyEdits(
      draft(),
      revision([
        { path: "slides", text: "x", fixes: "y" },
        { path: "slide.1.layout", text: "cover", fixes: "y" },
        { path: "caption", text: "   ", fixes: "y" },
      ]),
    );
    expect(applied).toEqual([]);
    expect(rejected).toHaveLength(3);
    expect(rejected[2]!.reason).toContain("cannot be blanked");
  });

  it("keeps a partly-bad revision's GOOD edits, because a refused path must not cost the fixes that resolved", () => {
    const { copy, applied, rejected } = applyCopyEdits(
      draft(),
      revision([
        { path: "slide.1.headline", text: "Fixed", fixes: "a" },
        { path: "slide.9.headline", text: "Invented", fixes: "b" },
      ]),
    );
    expect(applied.map((e) => e.path)).toEqual(["slide.1.headline"]);
    expect(rejected.map((r) => r.path)).toEqual(["slide.9.headline"]);
    expect(copy.slides.find((s) => s.n === 1)!.headline).toBe("Fixed");
  });
});

describe("addressableFields", () => {
  it("offers the reviser exactly the paths `applyCopyEdits` accepts", () => {
    const d = draft();
    const paths = addressableFields(d).map((f) => f.path);
    expect(paths).toContain("caption");
    expect(paths).toContain("slide.3.items.1.title");
    expect(paths).toContain("slide.5.stat.subLabel");
    expect(paths).toContain("slide.6.quote.text");
    // The round trip: every path it offers resolves. A path it offers and the
    // applier refuses is a prompt telling the model to fail.
    const { rejected } = applyCopyEdits(
      d,
      revision(addressableFields(d).slice(0, 12).map((f) => ({ path: f.path, text: "replacement", fixes: "round trip" }))),
    );
    expect(rejected).toEqual([]);
  });

  it("omits an absent optional field rather than offering a path that would be refused", () => {
    const paths = addressableFields(draft()).map((f) => f.path);
    expect(paths).not.toContain("slide.1.stat.subLabel");
    expect(paths).not.toContain("slide.3.items.2.note");
  });
});

describe("describeRevision", () => {
  it("names what changed, what was refused and what the reviser said it kept", () => {
    const d = draft();
    const rev = revision(
      [
        { path: "caption", text: "New", fixes: "dash" },
        { path: "slide.9.body", text: "x", fixes: "y" },
      ],
      "slide 5's figure, which the judge passed",
    );
    const line = describeRevision(applyCopyEdits(d, rev), rev);
    expect(line).toContain("revised 1 field(s) rather than rewriting the post");
    expect(line).toContain("1 edit(s) refused");
    expect(line).toContain("slide 5's figure");
  });
});
