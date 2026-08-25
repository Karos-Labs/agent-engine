import { describe, expect, it } from "vitest";
import { assertSafeMarkup, buildCustomArchetypeDocument, LEGACY_ARCHETYPE_IDS } from "../src/safety.js";

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

describe("LEGACY_ARCHETYPE_IDS", () => {
  it("names the six ids a custom archetype must never collide with", () => {
    expect(LEGACY_ARCHETYPE_IDS.has("photo")).toBe(true);
    expect(LEGACY_ARCHETYPE_IDS.has("stat_callout")).toBe(true);
    expect(LEGACY_ARCHETYPE_IDS.has("custom_something")).toBe(false);
  });
});
