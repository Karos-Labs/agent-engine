/**
 * schema.org JSON-LD generation for a blog article (SEO/GEO depth remediation,
 * migration-parity Batch 2.4). Legacy's `output-and-ux.md` §1/§3 names
 * "structured data in the head" as part of the standalone article page's
 * exact output — this is the piece of that contract Phase 1 never rebuilt.
 *
 * Deliberately pure functions, not an `AgentTool` — there's no model call and
 * no gate verdict here, just a deterministic transform of fields the draft
 * (and the workflow's own `deriveCanonicalUrl()`) already produced. Called
 * directly from `create-blog-agent-workflow.ts`'s persist step, the same way
 * `deriveCanonicalUrl()` itself is.
 *
 * Persisted shape: a **structured object** (`BlogJsonLd`), not a
 * pre-serialized JSON string. A future HTML renderer needs to emit each
 * schema as its own `<script type="application/ld+json">` tag, and tests
 * need to assert on individual fields (`headline`, `mainEntity[0].name`,
 * ...) — both are worse with a opaque string that would need re-parsing on
 * every read. `JSON.stringify(jsonLd.blogPosting)` at render time is a
 * one-line conversion; the reverse is not.
 */

export interface BuildBlogJsonLdInput {
  title: string;
  metaDescription: string;
  /** The workflow's own `deriveCanonicalUrl()` output — never fabricated here. Omitted (not invented) when the client has no configured domain. */
  canonicalUrl?: string;
  /** The client's own configured name (brand/profile), never a placeholder — falls back to the client's tenant slug when no display name is configured. */
  authorName: string;
  /** ISO 8601 timestamp — the workflow's own persist-time clock, not model-supplied. */
  datePublished: string;
  /** The draft's own `faqItems` (RFC-02 §5's GEO/AI-answer-engine field) — an empty array is valid and produces no `FAQPage` block. */
  faqItems: ReadonlyArray<{ question: string; answer: string }>;
}

export interface BlogPostingJsonLd {
  "@context": "https://schema.org";
  "@type": "BlogPosting";
  headline: string;
  datePublished: string;
  author: { "@type": "Organization"; name: string };
  description: string;
  mainEntityOfPage?: { "@type": "WebPage"; "@id": string };
  url?: string;
}

export interface FaqPageJsonLd {
  "@context": "https://schema.org";
  "@type": "FAQPage";
  mainEntity: Array<{
    "@type": "Question";
    name: string;
    acceptedAnswer: { "@type": "Answer"; text: string };
  }>;
}

export interface BlogJsonLd {
  blogPosting: BlogPostingJsonLd;
  /** Present only when the draft's `faqItems` is non-empty — no empty/placeholder `FAQPage` is ever emitted. */
  faqPage?: FaqPageJsonLd;
}

/** A `BlogPosting` JSON-LD object from the draft's own fields — `headline`/`description` from the draft, `mainEntityOfPage`/`url` from the workflow's `deriveCanonicalUrl()`, never the model's own (discarded) `canonicalUrl` guess. */
export function buildBlogPostingJsonLd(input: BuildBlogJsonLdInput): BlogPostingJsonLd {
  const page = input.canonicalUrl ? { "@type": "WebPage" as const, "@id": input.canonicalUrl } : undefined;
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: input.title,
    datePublished: input.datePublished,
    author: { "@type": "Organization", name: input.authorName },
    description: input.metaDescription,
    ...(page ? { mainEntityOfPage: page, url: input.canonicalUrl } : {}),
  };
}

/** A `FAQPage` JSON-LD object (one `Question`/`acceptedAnswer` pair per `faqItems` entry), or `undefined` when there are no FAQ items — never an empty `mainEntity` array. */
export function buildFaqPageJsonLd(faqItems: ReadonlyArray<{ question: string; answer: string }>): FaqPageJsonLd | undefined {
  if (faqItems.length === 0) return undefined;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqItems.map((item) => ({
      "@type": "Question" as const,
      name: item.question,
      acceptedAnswer: { "@type": "Answer" as const, text: item.answer },
    })),
  };
}

/** Builds the full JSON-LD block persisted alongside a blog deliverable: always a `BlogPosting`, plus a `FAQPage` only when `faqItems` is non-empty. */
export function buildBlogJsonLd(input: BuildBlogJsonLdInput): BlogJsonLd {
  const blogPosting = buildBlogPostingJsonLd(input);
  const faqPage = buildFaqPageJsonLd(input.faqItems);
  return faqPage ? { blogPosting, faqPage } : { blogPosting };
}
