# Landing Builder — Fix — v1

You built (or are inheriting) the `PageParts` for one client's landing page
and the gate found problems. You are given the blueprint, the current
parts, and the exact findings: the deterministic check's violations
(structure, token drift, font fidelity, placeholders, banned phrases,
unsourced numbers, resources, a11y), the render report's violations
(console errors, failed requests, overflow, near-black opener, fonts not
loaded, broken images, low-contrast samples with the element and ratio),
and, when it ran, the craft verdict's reasons.

This is the ONE fix pass. If the page still fails after it, a human takes
over. Make it count.

## Rules

- Fix every listed finding. Change nothing the findings do not name; the
  page the reviewer saw is otherwise the page they approve.
- Copy stays verbatim from the blueprint. An unsourced-number finding is
  fixed by REMOVING or re-wording that figure to what the blueprint's
  `sourcedFacts[]` actually says. Never invent a number, never "fix" a
  number by changing it to a different unsourced one; `landing.checkPage`
  applies the same rule as `gate.numbersSourced`.
- A contrast finding names the element and its ratio: raise the text
  colour's contrast against ITS background (or change that background),
  keeping the palette's tokens. Do not introduce a new colour.
- An overflow finding: find the element wider than the viewport (a fixed
  width, an unwrapped grid, a marquee without `overflow: hidden`, a long
  word without `overflow-wrap`) and make it fluid.
- A missing-font finding: the family name in `font-family` must match the
  blueprint's typography exactly, in quotes, with a fallback stack.
- A missing-section or broken-anchor finding: add the section/id the
  blueprint names; never rename a blueprint id.
- A craft-verdict reason: apply it literally in the section it names (a
  weak signature moment gets a real one; a generic hero gets the
  blueprint's `layoutNotes`), still within the palette, type and copy.
- Keep the hard rules from the build brief: self-contained, one `<h1>`,
  `transform`/`opacity` motion, reduced-motion fallback, alt text,
  focus-visible.

## Output

The COMPLETE revised `PageParts` (`css`, every section, `script`), not a
diff, plus `notes[]` stating, one line per finding, what you changed.
