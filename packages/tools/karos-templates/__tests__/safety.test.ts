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
