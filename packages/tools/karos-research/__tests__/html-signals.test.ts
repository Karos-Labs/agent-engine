import { describe, expect, it } from "vitest";
import {
  countAttributedQuotes,
  countFirstPersonMarkers,
  countNumericStats,
  daysSince,
  detectScript,
  extractJsonLd,
  extractPageSignals,
  fleschReadingEase,
  hasDefinitionalSentence,
  isQuestionHeading,
  keywordDensity,
  median,
  p75,
  stripTags,
} from "../src/html-signals.js";

const words = (n: number, word = "word") => Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ");

const PAGE = `<!doctype html><html lang="he"><head>
<title>גיקטיים - חדשות טכנולוגיה</title>
<meta name="description" content="${"ד".repeat(130)}">
<meta name="robots" content="index, follow, max-snippet:0">
<link rel="canonical" href="https://www.geektime.co.il/">
<link rel="alternate" hreflang="en" href="https://www.geektime.co.il/en/">
<meta name="viewport" content="width=device-width">
<meta property="article:modified_time" content="2026-09-01T10:00:00Z">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"NewsMediaOrganization","@id":"https://www.geektime.co.il/#org","name":"Geektime","sameAs":["a","b","c","d"]},{"@type":"NewsArticle","author":{"@type":"Person","name":"Dana Levi"},"dateModified":"2026-09-01T10:00:00Z"}]}</script>
<script type="application/ld+json">{ not json</script>
</head><body>
<nav><a href="/nav-link">nav</a> ${words(40, "nav")}</nav>
<main>
<h1>Geektime is Israel's largest tech news site</h1>
<p>${words(50, "opening")}</p>
<h2>What does Geektime cover?</h2>
<p>${words(45, "cap")}</p><p>${words(100, "body")} 42% of readers, said the editor "${words(6, "quote")} quoted words here".</p>
<h4>Skipped level</h4>
<p>${words(20, "short")} <a href="/inside">in</a> <a href="/inside2">in2</a> <a href="https://example.org/x">out</a> <a href="http://insecure.example/y">out2</a></p>
<h2>Plain heading</h2>
<p>${words(30, "answer")} We believe our readers deserve better.</p>
<img src="/a.png" alt="alt text"><img src="/b.png">
</main>
<footer>${words(30, "footer")}</footer>
</body></html>`;

describe("html-signals: on-page facts extracted from raw markup", () => {
  const page = extractPageSignals({ url: "https://geektime.co.il", finalUrl: "https://www.geektime.co.il/", status: 200, html: PAGE });

  it("reads the head: title length, description length, robots meta, canonical validity, viewport, hreflang, lang and script", () => {
    expect(page.title).toContain("גיקטיים");
    expect(page.titleLength).toBe(page.title!.length);
    expect(page.metaDescriptionLength).toBe(130);
    expect(page.metaRobots).toEqual({ noindex: false, nosnippet: false, maxSnippetZero: true });
    expect(page.canonical).toBe("https://www.geektime.co.il/");
    expect(page.canonicalValid).toBe(true);
    expect(page.viewportMeta).toBe(true);
    expect(page.hreflangCount).toBe(1);
    expect(page.lang).toBe("he");
    // The fixture's body filler is Latin and only the head is Hebrew; script follows the main text.
    expect(page.script).toBe("latin");
  });

  it("parses every JSON-LD block, counting the one that fails, and reads the Organization's sameAs/@id, the author and dateModified", () => {
    expect(page.jsonLd.blocks).toBe(2);
    expect(page.jsonLd.parseErrors).toBe(1);
    expect(page.jsonLd.types).toEqual(expect.arrayContaining(["NewsMediaOrganization", "NewsArticle"]));
    expect(page.jsonLd.organization).toEqual({ sameAsCount: 4, hasId: true });
    expect(page.jsonLd.authorName).toBe("Dana Levi");
    expect(page.dateModified).toBe("2026-09-01T10:00:00Z");
    expect(page.authorByline).toBe(true);
  });

  it("measures headings from <main> only: one H1, an H2->H4 skip, question detection, section and first-paragraph word counts", () => {
    expect(page.h1Count).toBe(1);
    expect(page.headingSkips).toBe(1);
    const h2 = page.headings.find((h) => h.text.startsWith("What does"));
    expect(h2?.isQuestion).toBe(true);
    expect(h2?.firstParagraphWordCount).toBe(45);
    expect(h2?.sectionWordCount).toBeGreaterThan(140);
    expect(h2?.externalLinkCount).toBe(0);
    expect(page.openingCapsule).toEqual({ wordCount: 50, bodyOffsetRatio: 0 });
    // The nav and footer words never reach the count.
    expect(page.headings.some((h) => h.text.includes("nav"))).toBe(false);
  });

  it("separates internal from external links, counts alt coverage and http:// resources on an https page", () => {
    expect(page.internalLinkCount).toBe(2);
    expect(page.externalDomains).toEqual(["example.org", "insecure.example"]);
    expect(page.images).toEqual({ total: 2, withAlt: 1 });
    expect(page.mixedContentCount).toBe(1);
    expect(page.https).toBe(true);
  });

  it("counts numeric stats, attributed quotes and first-person markers in the main text", () => {
    expect(page.numericStatCount).toBeGreaterThanOrEqual(1);
    expect(page.attributedQuoteCount).toBe(1);
    expect(page.firstPersonMarkerCount).toBeGreaterThanOrEqual(2);
  });

  it("hashes the main text so a later fetch can tell whether the body changed", () => {
    const again = extractPageSignals({ url: "https://geektime.co.il", finalUrl: "https://www.geektime.co.il/", status: 200, html: PAGE });
    expect(again.contentHash).toBe(page.contentHash);
    const changed = extractPageSignals({ url: "https://geektime.co.il", finalUrl: "https://www.geektime.co.il/", status: 200, html: PAGE.replace("Plain heading", "Different heading") });
    expect(changed.contentHash).not.toBe(page.contentHash);
    // Digits are normalised so a live view counter does not read as a content change.
    const counter = extractPageSignals({ url: "https://geektime.co.il", finalUrl: "https://www.geektime.co.il/", status: 200, html: PAGE.replace("42%", "57%") });
    expect(counter.contentHash).toBe(page.contentHash);
  });
});

describe("html-signals: the small pure helpers", () => {
  it("stripTags decodes entities and collapses whitespace", () => {
    expect(stripTags("<p>Tom &amp; Jerry&nbsp;&#8212; <b>bold</b></p>")).toBe("Tom & Jerry — bold");
  });

  it("isQuestionHeading accepts a trailing question mark or an interrogative opener in several languages", () => {
    expect(isQuestionHeading("How do I start?")).toBe(true);
    expect(isQuestionHeading("Why this matters")).toBe(true);
    expect(isQuestionHeading("מה זה גיקטיים")).toBe(true);
    expect(isQuestionHeading("Our story")).toBe(false);
  });

  it("countNumericStats counts percentages, currency and multi-digit figures but not single digits", () => {
    expect(countNumericStats("Revenue grew 12% to $4.5M across 3 regions and 2026 saw 120 launches.")).toBe(4);
  });

  it("countAttributedQuotes needs both a quotation and an attribution verb nearby", () => {
    expect(countAttributedQuotes('According to the CEO, "this was the best quarter we have had in years".')).toBe(1);
    expect(countAttributedQuotes('"this was the best quarter we have had in years" appears with nothing around it.')).toBe(0);
  });

  it("countFirstPersonMarkers finds English and Hebrew markers as whole words", () => {
    expect(countFirstPersonMarkers("We built this. Our team. אנחנו כאן. Nowhere.")).toBe(3);
  });

  it("hasDefinitionalSentence spots a short 'X is …' sentence near the top", () => {
    expect(hasDefinitionalSentence("Geektime is Israel's largest Hebrew tech news site. It launched in 2009.")).toBe(true);
    expect(hasDefinitionalSentence(words(40))).toBe(false);
  });

  it("keywordDensity reports the top token share and the most repeated 3-gram", () => {
    const text = `${"alpha beta gamma ".repeat(6)} delta epsilon`;
    const density = keywordDensity(text);
    expect(density.maxExactPhraseRepeats).toBe(6);
    expect(density.topTokenShare).toBeGreaterThan(0.25);
  });

  it("fleschReadingEase returns a number for Latin text and null for other scripts or very short text", () => {
    const english = "The cat sat on the mat. It was a warm day and the sun was out. Everyone was happy. ".repeat(3);
    expect(fleschReadingEase(english, "latin")).toBeGreaterThan(60);
    expect(fleschReadingEase("שלום עולם ".repeat(40), "hebrew")).toBeNull();
    expect(fleschReadingEase("Too short.", "latin")).toBeNull();
  });

  it("detectScript picks the dominant script", () => {
    expect(detectScript("Hello world, this is Latin text")).toBe("latin");
    expect(detectScript("שלום לכולם, זה טקסט בעברית")).toBe("hebrew");
    expect(detectScript("")).toBe("other");
  });

  it("extractJsonLd survives an empty block and nested @graph", () => {
    const html = '<script type="application/ld+json"></script><script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"X"}]}</script>';
    const parsed = extractJsonLd(html);
    expect(parsed).toMatchObject({ blocks: 2, parseErrors: 1, types: ["Organization"] });
  });

  it("median, p75 and daysSince behave on small inputs", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(p75([1, 2, 3, 4])).toBe(3);
    expect(median([])).toBe(0);
    expect(daysSince("2026-09-01T00:00:00Z", Date.parse("2026-09-11T00:00:00Z"))).toBe(10);
    expect(daysSince("not a date")).toBeUndefined();
    expect(daysSince(undefined)).toBeUndefined();
  });
});
