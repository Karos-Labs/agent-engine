import { describe, expect, it } from "vitest";
import { GMAIL_CLIP_BYTES, renderNewsletterEmail, renderNewsletterEmails, type RenderNewsletterEmailInput } from "../src/tools/render-email.js";

const KAROS_BRAND = {
  name: "Karos Labs",
  visualStyle: "Minimalist",
  fonts: { heading: "Inter", body: "Inter" },
  dominantColors: [
    { dominanceRank: 2, hex: "#242429", role: "Dark background/text" },
    { dominanceRank: 1, hex: "#ff6b2c", role: "Primary CTA background" },
  ],
};

function draft(): RenderNewsletterEmailInput["draft"] {
  return {
    subjectLine: "ChatGPT ads pass a $1 billion run rate",
    previewText: "Plus: what WPP's cuts say about agency pricing.",
    intro: "Three stories this week, and one thread running through them.",
    sections: [
      {
        heading: "OpenAI says ChatGPT ads reached a $1 billion run rate",
        body: "OpenAI announced the figure **less than 200 days** after launch. [Read the report](https://futureweek.com/week-in-review/)\n\nOur read: AI answers are now a paid placement.",
        linkUrl: "https://futureweek.com/week-in-review/",
      },
      {
        heading: "Also worth your time",
        body: "- **WPP cuts up to 1,000 more jobs** under its new CEO.\n- **Publicis wins PepsiCo** on an AI operating model.",
      },
    ],
    callToAction: { text: "Book a call with the team", url: "https://karoslabs.com/call" },
    signoff: "See you next week, the Karos Labs team",
  };
}

function render(overrides: Partial<RenderNewsletterEmailInput> = {}) {
  return renderNewsletterEmail({ draft: draft(), brand: KAROS_BRAND, profile: { name: "Karos Labs", website: "https://karoslabs.com/" }, issueDate: "5 Sep 2026", theme: "light", ...overrides });
}

describe("renderNewsletterEmail", () => {
  it("renders a standalone, email-safe document: 600px table layout, inline styles only, no scripts, no external CSS, no SVG", () => {
    const { html, bytes, gmailClipRisk } = render();
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('width="600"');
    expect(html).toContain('role="presentation"');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/<svg/i);
    expect(html).not.toMatch(/@import|url\(/i);
    expect(bytes).toBeGreaterThan(1000);
    expect(gmailClipRisk).toBe(false);
  });

  it("carries every field the subscriber reads: subject as title, hidden preheader, intro, headings, CTA button, signoff", () => {
    const { html } = render();
    expect(html).toContain("<title>ChatGPT ads pass a $1 billion run rate</title>");
    expect(html).toContain("Plus: what WPP&#39;s".replace("&#39;", "'"));
    expect(html).toMatch(/display:none;[^>]*>Plus: what WPP's cuts say about agency pricing\.<\/div>/);
    expect(html).toContain("Three stories this week, and one thread running through them.");
    expect(html).toContain("<h2");
    expect(html).toContain("OpenAI says ChatGPT ads reached a $1 billion run rate");
    expect(html).toContain('href="https://karoslabs.com/call"');
    expect(html).toContain("Book a call with the team");
    expect(html).toContain("See you next week, the Karos Labs team");
    expect(html).toContain("5 Sep 2026");
    expect(html).toContain("Karos Labs");
  });

  it("converts the craft guide's markdown subset: bold, links, bullets, paragraphs", () => {
    const { html } = render();
    expect(html).toContain("<strong>less than 200 days</strong>");
    expect(html).toContain('<a href="https://futureweek.com/week-in-review/"');
    expect(html).toContain(">Read the report</a>");
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain("<strong>WPP cuts up to 1,000 more jobs</strong>");
    // The section link becomes a "Read the full story" line.
    expect(html).toContain(">Read the full story</a>");
    // No raw markdown survives.
    expect(html).not.toContain("**");
    expect(html).not.toMatch(/\]\(https?:/);
  });

  it("escapes everything the model or the client wrote, and never links a non-http URL", () => {
    const d = draft();
    d.intro = 'Beware <script>alert("x")</script> & "quotes"';
    d.sections[0]!.body = "[click](javascript:alert(1)) and [ok](https://example.com/a?b=1&c=2)";
    d.callToAction = { text: "Go", url: "javascript:alert(2)" };
    const { html } = render({ draft: d });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;quotes&quot;");
    // The javascript: pseudo-link stays visible as the escaped text it is, never as a link.
    expect(html).not.toMatch(/href="javascript/i);
    expect(html).toContain("[click](javascript:alert(1))");
    expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"');
    // A CTA without a usable URL is still shown, as a label rather than a link.
    expect(html).toContain(">Go</span>");
  });

  it("appends the platform's compliance footer only when it is configured, with the unsubscribe URL as a link", () => {
    const withFooter = render({
      draft: { ...draft(), footerDisclaimer: "Karos Labs does not provide financial advice.", companyAddress: "12 Rothschild Blvd, Tel Aviv", unsubscribeUrl: "https://karoslabs.com/unsubscribe?id=abc" },
    });
    expect(withFooter.html).toContain("Karos Labs does not provide financial advice.");
    expect(withFooter.html).toContain("12 Rothschild Blvd, Tel Aviv");
    expect(withFooter.html).toContain('href="https://karoslabs.com/unsubscribe?id=abc"');
    expect(withFooter.html).toContain(">Unsubscribe</a>");

    const without = render();
    expect(without.html).not.toContain("Unsubscribe");
  });

  it("takes the CTA colour from the client's most dominant brand colour and a dark ink from the next one, in both themes", () => {
    const { light, dark } = renderNewsletterEmails({ draft: draft(), brand: KAROS_BRAND, profile: {} });
    expect(light.html).toContain("background:#ff6b2c");
    expect(dark.html).toContain("background:#ff6b2c");
    // Light: white card on a light page. Dark: the client's own dark colour is the page.
    expect(light.html).toContain("background:#ffffff");
    expect(dark.html).toContain("background:#242429");
    expect(light.html).not.toBe(dark.html);
    // Same words in both.
    for (const needle of ["Three stories this week", "Book a call with the team", "See you next week"]) {
      expect(light.html).toContain(needle);
      expect(dark.html).toContain(needle);
    }
  });

  it("falls back to a neutral palette and the profile name when the brand kit is empty", () => {
    const { html } = render({ brand: {}, profile: { name: "Acme Corp" } });
    expect(html).toContain("Acme Corp");
    expect(html).toContain("background:#111827");
    expect(html).toContain("Helvetica, Arial, sans-serif");
  });

  it("uses the brand fonts with an email-safe fallback stack, sanitised", () => {
    const { html } = render({ brand: { fonts: { heading: "Space Grotesk; } body { color: red", body: "Inter" } } });
    expect(html).toContain("'Space Grotesk  body  color: red', Helvetica, Arial, sans-serif");
    expect(html).toContain("'Inter', Helvetica, Arial, sans-serif");
  });

  it("renders a Hebrew edition right to left", () => {
    const d = draft();
    d.subjectLine = "שלוש ידיעות ורעיון אחד";
    d.intro = "השבוע: מה קרה בשוק הפרסום ומה זה אומר לכם.";
    const { html, direction } = render({ draft: d });
    expect(direction).toBe("rtl");
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("text-align:right");
  });

  it("shows the logo when the brand kit has an http(s) logo URL, otherwise the name", () => {
    const withLogo = render({ brand: { ...KAROS_BRAND, logoUrl: "https://cdn.karoslabs.com/logo.png" } });
    expect(withLogo.html).toContain('<img src="https://cdn.karoslabs.com/logo.png" alt="Karos Labs"');
    const badLogo = render({ brand: { ...KAROS_BRAND, logoUrl: "data:image/png;base64,AAAA" } });
    expect(badLogo.html).not.toContain("<img");
    expect(badLogo.html).toContain("Karos Labs</span>");
  });

  it("flags the Gmail clipping risk past 102 KB", () => {
    const d = draft();
    d.sections = Array.from({ length: 60 }, (_, i) => ({ heading: `Story ${i}`, body: "x".repeat(2_000) }));
    const { bytes, gmailClipRisk } = render({ draft: d });
    expect(bytes).toBeGreaterThan(GMAIL_CLIP_BYTES);
    expect(gmailClipRisk).toBe(true);
  });

  it("is deterministic: the same input renders the same bytes", () => {
    expect(render().html).toBe(render().html);
  });
});
