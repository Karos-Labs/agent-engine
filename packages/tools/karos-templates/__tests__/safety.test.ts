import { describe, expect, it } from "vitest";
import { assertSafeMarkup, buildCustomArchetypeDocument, buildStudioTemplateDocument, LEGACY_ARCHETYPE_IDS } from "../src/safety.js";

describe("assertSafeMarkup", () => {
  const slots = ["headline", "note"];

  it("accepts a clean fragment using only declared slots plus kicker/dir", () => {
    const result = assertSafeMarkup(
      `<div class="hook"><span>{{kicker}}</span><h1 dir="{{dir}}">{{headline}}</h1><p>{{note}}</p></div>`,
      `.hook h1 { color: var(--accent); font-family: var(--f-display); }`,
      slots,
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ["<script>alert(1)</script>", "open script tag"],
    ["<SCRIPT>alert(1)</SCRIPT>", "case-insensitive script tag"],
    ["text</script><script>bad()", "close-then-open script tag"],
    ["<style>.a{color:red}</style>", "style tag"],
    ["<link rel='stylesheet' href='https://evil.example/x.css'>", "link tag"],
    ["<iframe src='https://evil.example'></iframe>", "iframe tag"],
    ["<object data='x'></object>", "object tag"],
    ["<embed src='x'>", "embed tag"],
    ["<meta http-equiv='refresh' content='0;url=https://evil.example'>", "meta refresh"],
    ["<base href='https://evil.example/'>", "base tag"],
    ["<form action='https://evil.example'><input></form>", "form tag"],
    ["<svg onload='alert(1)'></svg>", "svg tag"],
    ["<math><mtext></mtext></math>", "math tag"],
    ["<div style='background:url(javascript:alert(1))'>{{headline}}</div>", "inline style attribute"],
    ["<div onclick='alert(1)'>{{headline}}</div>", "event handler attribute"],
    ["<a href='java\tscript:alert(1)'>{{headline}}</a>", "whitespace-evaded javascript: URL"],
  ])("rejects bodyHtml containing %s (%s)", (bodyHtml) => {
    const result = assertSafeMarkup(bodyHtml, "", slots);
    expect(result.ok).toBe(false);
  });

  it("rejects bodyHtml referencing an undeclared placeholder", () => {
    const result = assertSafeMarkup("<div>{{notDeclared}}</div>", "", slots);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("notDeclared");
  });

  it("rejects bodyHtml reaching for the reserved {{html:...}} or {{image:...}} forms", () => {
    expect(assertSafeMarkup("<div>{{html:rows}}</div>", "", slots).ok).toBe(false);
    expect(assertSafeMarkup("<img src='{{image:hero}}'>", "", slots).ok).toBe(false);
  });

  // Phase 2, item N gate 3: a studio cover cannot exist without
  // `{{image:hero}}`, and the permission is a decision at the call site
  // rather than a property of the markup — a run-authored custom archetype
  // passes no options and keeps the stricter contract above verbatim.
  describe("the opt-in privileged-slot allowlist", () => {
    it("accepts {{image:hero}} when, and only when, the caller opted that name in", () => {
      expect(assertSafeMarkup("<img class='hero' src='{{image:hero}}'>", "", slots, { allowImageSlots: ["hero"] }).ok).toBe(true);
      const other = assertSafeMarkup("<img src='{{image:backdrop}}'>", "", slots, { allowImageSlots: ["hero"] });
      expect(other.ok).toBe(false);
      if (!other.ok) {
        expect(other.reason).toContain("backdrop");
        expect(other.reason).toContain("allowImageSlots");
      }
    });

    it("accepts {{html:device}} when opted in, and still refuses a second html slot that was not", () => {
      expect(assertSafeMarkup("<div>{{html:device}}</div>", "", slots, { allowHtmlSlots: ["device"] }).ok).toBe(true);
      const refused = assertSafeMarkup("<div>{{html:device}}{{html:rows}}</div>", "", slots, { allowHtmlSlots: ["device"] });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.reason).toContain("rows");
    });

    it("keeps the two forms separate — an image allowlist never licenses an html slot", () => {
      expect(assertSafeMarkup("<div>{{html:hero}}</div>", "", slots, { allowImageSlots: ["hero"] }).ok).toBe(false);
      expect(assertSafeMarkup("<img src='{{image:device}}'>", "", slots, { allowHtmlSlots: ["device"] }).ok).toBe(false);
    });

    it("names the missing opt-in when no allowlist was passed at all, so the refusal says what to do", () => {
      const result = assertSafeMarkup("<img src='{{image:hero}}'>", "", slots);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("allowImageSlots");
    });

    it("still refuses every other danger in an allowlisted fragment — the opt-in widens one form, not the contract", () => {
      expect(assertSafeMarkup("<script>x()</script><img src='{{image:hero}}'>", "", slots, { allowImageSlots: ["hero"] }).ok).toBe(false);
      expect(assertSafeMarkup("<img src='{{image:hero}}'>{{undeclared}}", "", slots, { allowImageSlots: ["hero"] }).ok).toBe(false);
    });
  });

  it("rejects css containing any '<' character, closing the </style><script> breakout through composeDocument's splice point", () => {
    const result = assertSafeMarkup("<div>{{headline}}</div>", "</style><script>alert(1)</script>", slots);
    expect(result.ok).toBe(false);
  });

  it("rejects css reaching for @import or url(", () => {
    expect(assertSafeMarkup("<div>{{headline}}</div>", "@import 'https://evil.example/x.css';", slots).ok).toBe(false);
    expect(assertSafeMarkup("<div>{{headline}}</div>", ".a { background: url(https://evil.example/x.png); }", slots).ok).toBe(false);
  });
});

describe("buildCustomArchetypeDocument", () => {
  it("wraps the fragment in a complete document with the code-owned ready-flag script", () => {
    const doc = buildCustomArchetypeDocument("<div>{{headline}}</div>");
    expect(doc).toContain("<div>{{headline}}</div>");
    expect(doc).toContain("window.__CAROUSEL_READY__ = true;");
    expect(doc).toContain("</head>");
    expect(doc).toContain("width: 1080px; height: 1440px;");
  });
});

describe("buildStudioTemplateDocument", () => {
  it("wraps a studio fragment in the same code-owned shell, ready flag included", () => {
    const doc = buildStudioTemplateDocument(`<div class="hook">{{title}}</div>`);
    expect(doc).toContain(`<div class="hook">{{title}}</div>`);
    // The one script every rendered slide needs is the harness's to write:
    // a designer that forgot the flag would hang the render, one that set it
    // early would screenshot an unpainted page.
    expect(doc).toContain("window.__CAROUSEL_READY__ = true;");
    expect(doc).toContain("width: 1080px; height: 1440px;");
    expect(doc).toContain("instagram-agent studio template");
  });

  it("declares the lang SLOT, not a hardcoded en, on both code-written shells", () => {
    // Phase 4 (RFC-15 §7.2). The eight bundled templates are source files and
    // `bidi-isolation.test.ts` scans them; this shell is written in CODE, so
    // that scan cannot see it — and it is the shell behind BOTH Template
    // Studio rows and model-authored custom archetypes. A `lang="en"` here
    // means a Hebrew studio template renders as an English document: the
    // browser picks Latin font fallback for Hebrew glyphs and hyphenates by
    // English rules, which is the exact defect the slot exists to close, on
    // the one path nothing else covers.
    for (const doc of [buildStudioTemplateDocument("<div>{{title}}</div>"), buildCustomArchetypeDocument("<div>{{title}}</div>")]) {
      expect(doc).toContain(`<html lang="{{lang}}" dir="{{dir}}">`);
      expect(doc).not.toContain(`lang="en"`);
    }
  });

  it("differs from the custom-archetype document only in its title, so the trace names which path built it", () => {
    const studio = buildStudioTemplateDocument("<div>{{title}}</div>");
    const custom = buildCustomArchetypeDocument("<div>{{title}}</div>");
    expect(studio).not.toBe(custom);
    expect(studio.replace("instagram-agent studio template", "instagram-agent custom archetype")).toBe(custom);
  });
});

describe("LEGACY_ARCHETYPE_IDS", () => {
  it("names the eight ids a custom archetype must never collide with", () => {
    expect(LEGACY_ARCHETYPE_IDS.has("photo")).toBe(true);
    expect(LEGACY_ARCHETYPE_IDS.has("stat_callout")).toBe(true);
    expect(LEGACY_ARCHETYPE_IDS.has("custom_something")).toBe(false);
  });

  // Phase 2, item M: both new bundled archetypes land as files in the same
  // per-run directory, so a `custom_`-prefixed collision must be impossible
  // for them too.
  it("knows the two Phase 2 archetypes, so a custom_ archetype can never overwrite cover.html or closer.html", () => {
    expect(LEGACY_ARCHETYPE_IDS.has("cover")).toBe(true);
    expect(LEGACY_ARCHETYPE_IDS.has("closer")).toBe(true);
    expect(LEGACY_ARCHETYPE_IDS.size).toBe(8);
  });
});

/**
 * # A STUDIO TEMPLATE THAT GOT NO PICTURE MUST NOT PAINT THE FRAME ANYWAY
 *
 * The Geektime prep carousel of 2026-09-18 opened on a 1080x620 grey-green
 * gradient rectangle above the headline. That rectangle was the cover's
 * picture frame, rendered at full size around an `<img src="">`, because
 * `fillTemplate` erases a slot nobody filled and leaves the element in the
 * document. The owner read it, correctly, as the post being broken rather
 * than as the post having no photograph.
 *
 * The bundled plates have carried this rule for `.sc-figure-band` since the
 * same defect shipped there once already (`figure-band-collapse.test.ts`,
 * which is where the source-scan instrument below is borrowed from, and its
 * reasoning applies unchanged: an empty `src` may not fire `error` at all,
 * and if it does it fires asynchronously, so a collapse has to be true at
 * parse time).
 *
 * What is different here is that studio markup is MODEL-AUTHORED. There is no
 * class name to hang the rule on, so it has to be structural and it has to
 * live in the one shell code owns — which is the shell these two builders
 * return.
 */
describe("the code-owned shell collapses an unfilled picture", () => {
  const SHELLS = [
    ["studio template", buildStudioTemplateDocument("<div>{{title}}</div>")],
    ["custom archetype", buildCustomArchetypeDocument("<div>{{title}}</div>")],
  ] as const;

  it("hides the image element itself when its src was erased", () => {
    for (const [what, doc] of SHELLS) {
      expect(doc, what).toMatch(/img\[src=""\][^{]*\{[^}]*display:\s*none/);
    }
  });

  it("collapses the CONTAINER, not just the image — the frame is what painted the hole", () => {
    for (const [what, doc] of SHELLS) {
      // The container rule, asserted by its three clauses rather than by its
      // exact text. Each one is load-bearing and each has a way of being
      // quietly dropped in a rewrite:
      //
      //   1. it fires on an UNFILLED img       — or it collapses good frames;
      //   2. not when a FILLED img sits beside — or a two-picture frame with
      //      one missing takes the whole frame down;
      //   3. not when a non-img child exists   — or a frame that also holds a
      //      caption loses the caption.
      const rule = doc.match(/:has\(> img\[src=""\]\)[^{]*\{[^}]*display:\s*none[^}]*\}/)?.[0];
      expect(rule, `${what}: no structural container-collapse rule at all`).toBeDefined();
      expect(rule, `${what}: clause 2 missing — a frame holding one good picture and one gap would vanish`).toContain(
        ':not(:has(> img[src]:not([src=""])))',
      );
      expect(rule, `${what}: clause 3 missing — a frame that also holds a caption would lose it`).toContain(
        ":not(:has(> *:not(img)))",
      );
    }
  });

  it("names no class, because the markup it has to work on is written by a model", () => {
    for (const [what, doc] of SHELLS) {
      const rule = doc.match(/:has\(> img\[src=""\]\)[^{]*\{/)?.[0] ?? "";
      expect(rule, `${what}: the rule is scoped to a class the studio's designer agent has no obligation to use`).not.toMatch(
        /\.[A-Za-z]/,
      );
    }
  });
});
