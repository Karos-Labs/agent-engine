import type { RenderCarouselInput, Slide } from "@agent-engine/tool-karos-publish";
import type { BrandTokens, ImageSelection, InstagramCopyOutput, ResearchOutput, SlidesDataSelfCheck, StyleConfig } from "./types.js";

/**
 * RFC-03 §3 step 07's self-check, run before `slides-data.json` is ever
 * handed to the renderer: "every claim traces to a source, every config
 * rule with `check: 'copy'` passes, slide count matches step 06." A failure
 * here drives the workflow's own capped "RETURN: 05" retry loop
 * (`create-instagram-agent-workflow.ts`) — this function itself never
 * retries anything; it just reports pass/fail plus a human-readable reason.
 *
 * `styleConfig.rules[]` entries with `check: "copy"` are descriptive/audit
 * labels in this Phase-1 schema — the actual checkable conditions they
 * describe live in `banned_words`/`banned_chars`/`compliance` below, which
 * this function evaluates directly rather than interpreting `rules[]` as a
 * mini rule-engine with no real semantics yet. (A prior version of this
 * comment attributed that choice to an invented RFC-03 quote — no such
 * instruction exists in RFC-03; this is this package's own Phase-1 scoping
 * decision.) `check: "render"` rules are out of scope for this function
 * entirely — those are checked post-render, against the rendered attempt's
 * structured slide data, by step 08b's `InstagramVisualQaAgent` instead.
 */
export function checkSlidesData(
  copy: InstagramCopyOutput,
  selections: ImageSelection[],
  research: ResearchOutput,
  styleConfig: StyleConfig,
): SlidesDataSelfCheck {
  const { canvas, banned_words: bannedWords, banned_chars: bannedChars, compliance } = styleConfig;

  if (copy.slides.length < canvas.slides_min || copy.slides.length > canvas.slides_max) {
    return {
      ok: false,
      reason: `slide count ${copy.slides.length} is outside the configured range [${canvas.slides_min}, ${canvas.slides_max}]`,
    };
  }

  // "slide count matches step 06" (RFC-03 §3 step 07) — every copy slide must
  // have exactly one corresponding vetted image selection, no more, no fewer.
  if (selections.length !== copy.slides.length) {
    return {
      ok: false,
      reason: `image selection count (${selections.length}) does not match slide count (${copy.slides.length})`,
    };
  }
  const selectionNs = new Set(selections.map((s) => s.n));
  for (const slide of copy.slides) {
    if (!selectionNs.has(slide.n)) {
      return { ok: false, reason: `slide ${slide.n} has no corresponding image selection` };
    }
  }

  // "every claim traces to a source" (RFC-03 §3 step 07) — sourceRef must
  // name a step-04 fact's claim verbatim, not a paraphrase.
  const factClaims = new Set(research.facts.map((f) => f.claim));
  for (const slide of copy.slides) {
    if (!factClaims.has(slide.sourceRef)) {
      return {
        ok: false,
        reason: `slide ${slide.n}'s sourceRef does not match any research fact's claim verbatim: "${slide.sourceRef}"`,
      };
    }
  }

  for (const slide of copy.slides) {
    const slideText = `${slide.headline} ${slide.body}`;
    const lowerSlideText = slideText.toLowerCase();
    for (const word of bannedWords) {
      if (word.length > 0 && lowerSlideText.includes(word.toLowerCase())) {
        return { ok: false, reason: `slide ${slide.n} uses a banned word: "${word}"` };
      }
    }
    for (const char of bannedChars) {
      if (char.length > 0 && slideText.includes(char)) {
        return { ok: false, reason: `slide ${slide.n} uses a banned character: "${char}"` };
      }
    }
  }

  if (compliance.regulated) {
    const combinedLower = copy.slides.map((s) => `${s.headline}\n${s.body}`).join("\n").toLowerCase();
    for (const phrase of compliance.required_framing) {
      if (!combinedLower.includes(phrase.toLowerCase())) {
        return { ok: false, reason: `regulated client's required framing phrase is missing from the post: "${phrase}"` };
      }
    }
    for (const phrase of compliance.never_say) {
      if (combinedLower.includes(phrase.toLowerCase())) {
        return { ok: false, reason: `regulated client's post contains a "never say" phrase: "${phrase}"` };
      }
    }
  }

  return { ok: true };
}

/**
 * Assembles the exact `publish.renderCarousel` input contract (RFC-03 §1
 * required-reading item 1's schema, imported straight from
 * `@agent-engine/tool-karos-publish` rather than redeclared here — one
 * schema, not two that could drift). Only ever called after
 * `checkSlidesData` has already passed. `outDir` is deterministic per
 * `(clientSlug, postId)` so re-running this on resume lands on the same
 * output directory rather than a fresh one each attempt.
 */
export function assembleSlidesData(params: {
  clientSlug: string;
  postId: string;
  repoRoot: string;
  brandTokens: BrandTokens;
  copy: InstagramCopyOutput;
  selections: ImageSelection[];
  canvas: StyleConfig["canvas"];
}): RenderCarouselInput {
  const selectionByN = new Map(params.selections.map((s) => [s.n, s]));

  // The default template (agents/instagram-agent/assets/templates/default/slide.html,
  // agent-engine#4) reads this as a CSS custom property — falls back to that template's
  // own legacy-palette accent (see its doc comment) when a client hasn't set one yet.
  // `logoPath` isn't threaded through here: the default template has no wordmark
  // slot (no client-name field exists anywhere in this agent's per-slide contract to
  // put next to one), so wiring it through would have nothing real to attach to.
  const accentColor = params.brandTokens.accentColor ?? "#C4552F";

  const slides: Slide[] = params.copy.slides.map((slide) => {
    const selection = selectionByN.get(slide.n);
    const imagePath = selection?.imagePath ?? undefined;
    return {
      n: slide.n,
      template: params.brandTokens.slideTemplate,
      fields: { headline: slide.headline, body: slide.body, accentColor },
      images: imagePath ? { hero: imagePath } : {},
    };
  });

  return {
    client: params.clientSlug,
    postId: params.postId,
    templateDir: params.brandTokens.templateDir,
    outDir: `instagram-output/${params.clientSlug}/${params.postId}`,
    repoRoot: params.repoRoot,
    slides,
    canvas: params.canvas,
    readyFlag: "__CAROUSEL_READY__",
  };
}
