import { describe, expect, it } from "vitest";
import { buildBlogJsonLd, buildBlogPostingJsonLd, buildFaqPageJsonLd } from "../src/tools/json-ld.js";

describe("json-ld.ts: schema.org structured data (SEO/GEO remediation)", () => {
  describe("buildBlogPostingJsonLd", () => {
    it("builds a BlogPosting object from the draft's own title/metaDescription plus the workflow's canonicalUrl", () => {
      const result = buildBlogPostingJsonLd({
        title: "How settlement actually works",
        metaDescription: "A plain-language explanation of settlement mechanics.",
        canonicalUrl: "https://acme.com/blog/how-settlement-works",
        authorName: "Acme Corp",
        datePublished: "2026-08-16T00:00:00.000Z",
        faqItems: [],
      });

      expect(result["@context"]).toBe("https://schema.org");
      expect(result["@type"]).toBe("BlogPosting");
      expect(result.headline).toBe("How settlement actually works");
      expect(result.description).toBe("A plain-language explanation of settlement mechanics.");
      expect(result.datePublished).toBe("2026-08-16T00:00:00.000Z");
      expect(result.author).toEqual({ "@type": "Organization", name: "Acme Corp" });
      expect(result.mainEntityOfPage).toEqual({ "@type": "WebPage", "@id": "https://acme.com/blog/how-settlement-works" });
      expect(result.url).toBe("https://acme.com/blog/how-settlement-works");
    });

    it("omits mainEntityOfPage and url (never fabricating a URL) when no canonicalUrl was derived", () => {
      const result = buildBlogPostingJsonLd({
        title: "A title",
        metaDescription: "A description.",
        authorName: "Acme Corp",
        datePublished: "2026-08-16T00:00:00.000Z",
        faqItems: [],
      });

      expect(result.mainEntityOfPage).toBeUndefined();
      expect(result.url).toBeUndefined();
      expect(result.headline).toBe("A title");
    });
  });

  describe("buildFaqPageJsonLd", () => {
    it("returns undefined for an empty faqItems array — no empty/placeholder FAQPage is ever emitted", () => {
      expect(buildFaqPageJsonLd([])).toBeUndefined();
    });

    it("builds a FAQPage with one Question/acceptedAnswer pair per faqItems entry", () => {
      const result = buildFaqPageJsonLd([
        { question: "How long did the rollout take?", answer: "About one quarter before results were measurable." },
        { question: "Did retention suffer?", answer: "No, retention held steady at the 90-day mark." },
      ]);

      expect(result).toBeDefined();
      expect(result!["@context"]).toBe("https://schema.org");
      expect(result!["@type"]).toBe("FAQPage");
      expect(result!.mainEntity).toHaveLength(2);
      expect(result!.mainEntity[0]).toEqual({
        "@type": "Question",
        name: "How long did the rollout take?",
        acceptedAnswer: { "@type": "Answer", text: "About one quarter before results were measurable." },
      });
      expect(result!.mainEntity[1]!.name).toBe("Did retention suffer?");
    });
  });

  describe("buildBlogJsonLd", () => {
    it("always includes blogPosting, and includes faqPage only when faqItems is non-empty", () => {
      const withoutFaq = buildBlogJsonLd({
        title: "A title",
        metaDescription: "A description.",
        authorName: "Acme Corp",
        datePublished: "2026-08-16T00:00:00.000Z",
        faqItems: [],
      });
      expect(withoutFaq.blogPosting).toBeDefined();
      expect(withoutFaq.faqPage).toBeUndefined();

      const withFaq = buildBlogJsonLd({
        title: "A title",
        metaDescription: "A description.",
        authorName: "Acme Corp",
        datePublished: "2026-08-16T00:00:00.000Z",
        faqItems: [{ question: "Q?", answer: "A." }],
      });
      expect(withFaq.blogPosting).toBeDefined();
      expect(withFaq.faqPage).toBeDefined();
      expect(withFaq.faqPage!.mainEntity).toHaveLength(1);
    });
  });
});
