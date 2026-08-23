import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────
// Style config + brand tokens (RFC-03 step 02 — "freeze the small files")
// ─────────────────────────────────────────────────────────────────────────

/**
 * A single content rule from the client's style config. `check` names which
 * half of the pipeline the rule is checkable against — `"copy"` (a text
 * rule, checked deterministically against slide text inside step 07's
 * self-check: banned words/chars, `compliance` framing) or `"render"` (only
 * checkable on the rendered pixels/structured slide output — step 08b's
 * visual QA, see `InstagramVisualQaAgent`).
 *
 * P0 parity-audit fix: this used to be `z.literal("copy")` only, which
 * rejected every real legacy-shaped `02-style-config.json` at intake, since
 * `assets/style-config-template.json`'s own 5 worked examples are 100%
 * `check: "render"` rules (nothing-overlaps, no-empty-closer, figures-are-
 * designed, mono-face-sparingly, real-photo-person-chips — none of them are
 * text rules). A prior version of this comment attributed the original
 * `"copy"`-only narrowing to an invented RFC-03 quote ("you don't need every
 * legacy field, just enough to genuinely validate") that does not appear
 * anywhere in RFC-03 — there was never an RFC instruction to drop `"render"`
 * support. Widening this to `z.enum(["copy", "render"])` is a deliberate
 * fidelity fix to match the real template's rule-type contract, not a
 * response to anything RFC-03 said.
 */
export const StyleRuleSchema = z.object({
  id: z.string().min(1),
  check: z.enum(["copy", "render"]),
  description: z.string().min(1),
});
export type StyleRule = z.infer<typeof StyleRuleSchema>;

/**
 * The canvas block, shaped identically to `publish.renderCarousel`'s own
 * `CanvasSchema` (`@agent-engine/tool-karos-publish`) so step 02's frozen
 * config can be passed straight into the render tool's input at step 08
 * with zero translation — one canvas definition, not two that could drift.
 * `scale` has no default here (unlike the render tool's own schema): a
 * client's style config must say `2` explicitly, on purpose — RFC-03's step
 * 02 is a parse-*and*-validate gate, and silently defaulting a client's own
 * frozen config file to the right value would hide a real client-config bug
 * instead of catching it at intake.
 */
export const StyleConfigCanvasSchema = z.object({
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  scale: z.number(),
  slides_min: z.number().int().positive(),
  slides_max: z.number().int().positive(),
});
export type StyleConfigCanvas = z.infer<typeof StyleConfigCanvasSchema>;

/**
 * The compliance block (regulated clients only, but present with defaults
 * either way — RFC-03's `compliance: {regulated, required_framing[],
 * never_say[]}`). When `regulated` is true, step 07's self-check requires
 * every `required_framing` phrase to appear somewhere in the post's copy and
 * refuses any `never_say` phrase anywhere in it.
 */
export const StyleComplianceSchema = z.object({
  regulated: z.boolean(),
  required_framing: z.array(z.string()).default([]),
  never_say: z.array(z.string()).default([]),
});
export type StyleCompliance = z.infer<typeof StyleComplianceSchema>;

/**
 * The frozen `02-style-config.json` shape (RFC-03 §1 required-reading list,
 * item 1) — step 02 parses the client's config against this schema and
 * throws `WorkflowBlockedIntake` on any failure (missing file, wrong
 * version, malformed canvas, `scale !== 2`, etc.) rather than ever falling
 * back to defaults silently. This is the "parse-check-or-HALT" gate.
 */
export const StyleConfigSchema = z.object({
  style_config_version: z.number().int().positive(),
  canvas: StyleConfigCanvasSchema,
  rules: z.array(StyleRuleSchema).default([]),
  banned_words: z.array(z.string()).default([]),
  banned_chars: z.array(z.string()).default([]),
  compliance: StyleComplianceSchema,
});
export type StyleConfig = z.infer<typeof StyleConfigSchema>;

/**
 * The brand-tokens half of step 02's "freeze the small files" (RFC-03 §3
 * step 02) — just enough to feed the render step's `templateDir` and to
 * give slide copy a couple of on-brand fields (`accentColor`) without
 * pulling in the full legacy brand-kit file. `templateDir` is repo-relative
 * on purpose: it flows straight into `publish.renderCarousel`'s own
 * `templateDir` input, which `assertInside` (RFC-03 §1 required-reading
 * item 2) refuses to accept as an absolute path.
 *
 * RESOLVED (karoslabs/agent-engine#4): a real, non-`__tests__` default now
 * ships at `agents/instagram-agent/assets/templates/default/slide.html`
 * (`slideTemplate` still defaults to `"slide.html"`, matching it) — a new
 * client's `templateDir` should point there unless/until it has its own.
 * Adapted from karos-agents' legacy `marketing-services` CSS design tokens
 * for visual parity — see that file's own doc comment for exactly what was
 * and wasn't ported.
 */
export const BrandTokensSchema = z.object({
  templateDir: z.string().min(1),
  /** The single shared slide template file (repo-relative to `templateDir`) every slide renders through — RFC-03 §1's "one static renderer/template serves every client" fix #2, never a per-agent-invented template. */
  slideTemplate: z.string().min(1).default("slide.html"),
  accentColor: z.string().min(1).optional(),
  logoPath: z.string().min(1).optional(),
});
export type BrandTokens = z.infer<typeof BrandTokensSchema>;

/** What step 02 hands forward to every later step. */
export interface InstagramFrozenConfig {
  styleConfig: StyleConfig;
  brandTokens: BrandTokens;
}

// ─────────────────────────────────────────────────────────────────────────
// Step 01 — open run / claim post number
// ─────────────────────────────────────────────────────────────────────────

/** What step 01 hands forward. `postId` is the run's own idempotency key (RFC-01 §9.1 rule 2) — stable across resumes of the same `runId`. */
export interface InstagramRunClaim {
  postId: string;
  postNumber: number;
  /** An optional client-supplied steer (lane/subject) for this run — may pick a lane, never relax the topics-catalog lock (RFC-03 §3 step 01's note). */
  requestedLane?: string;
  requestedSubject?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Step 03 — claim topic
// ─────────────────────────────────────────────────────────────────────────

/** Where step 03's subject came from — decides whether there is a dedup reservation to commit at step 09. */
export type InstagramTopicSource = "reserved" | "requested" | "research";

export interface InstagramTopicClaim {
  /**
   * OPTIONAL, because only a `"reserved"` claim has one.
   *
   * It used to be required, which encoded the assumption that the topics
   * catalog is the sole possible origin of a subject — and that assumption is
   * exactly what made a client with no seeded catalog unable to run this agent
   * at all: `topics.reserve` reported a floor breach, step 03 threw
   * `WorkflowHeld`, and the run ended having produced nothing. `topics.commit`
   * at step 09 is now conditional on this field, matching what `x-agent` has
   * always done with its own `XTopicReservation.reservationKey`.
   */
  reservationKey?: string;
  topic: string;
  source: InstagramTopicSource;
}

// ─────────────────────────────────────────────────────────────────────────
// Step 04 — research (InstagramResearchAgent's output)
// ─────────────────────────────────────────────────────────────────────────

/** One sourced fact — "every fact that will reach a slide needs a source + date" (RFC-03 §3 step 04). */
export const ResearchFactSchema = z.object({
  claim: z.string().min(1),
  source: z.string().min(1),
  date: z.string().min(1),
});
export type ResearchFact = z.infer<typeof ResearchFactSchema>;

/**
 * `InstagramResearchAgent`'s output. `rawPayloadRef` is the `research.pull`
 * run id whose raw payload was captured verbatim (by `research.pull` itself,
 * before this agent ever sees it) — RFC-03 §1's "verbatim raw payload
 * capture" requirement is satisfied by `research.pull`'s own design, not
 * reimplemented here; this field just carries the pointer forward so step
 * 07's self-check and step 09's ledger record can trace every fact back to it.
 */
export const ResearchOutputSchema = z.object({
  topic: z.string().min(1),
  facts: z.array(ResearchFactSchema).min(1),
  rawPayloadRef: z.string().min(1),
});
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Step 05 — write copy (InstagramCopyAgent's output)
// ─────────────────────────────────────────────────────────────────────────

/**
 * One slide's copy — "one idea each" (RFC-03 §3 step 05). `visualNeed` is
 * what step 06 vets a picture against; `sourceRef` must name one of step
 * 04's `facts[].claim` values verbatim, which is exactly what step 07's
 * self-check verifies ("every claim traces to a source").
 */
export const InstagramSlideCopySchema = z.object({
  n: z.number().int().positive(),
  headline: z.string().min(1),
  body: z.string().min(1),
  visualNeed: z.string().min(1),
  sourceRef: z.string().min(1),
});
export type InstagramSlideCopy = z.infer<typeof InstagramSlideCopySchema>;

/** `InstagramCopyAgent`'s output — six to eight slides (RFC-03 §3 step 05), enforced directly in the schema. */
export const InstagramCopyOutputSchema = z.object({
  slides: z.array(InstagramSlideCopySchema).min(6).max(8),
});
export type InstagramCopyOutput = z.infer<typeof InstagramCopyOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Step 06 — source + vet images (InstagramImageVettingAgent's output)
// ─────────────────────────────────────────────────────────────────────────

/**
 * One slide's image candidate pool entry — a repo-relative path plus a
 * short human-readable description the vetting agent judges against the
 * slide's `visualNeed`. Phase 1 has no real internet image-search tool
 * (RFC-03 §1) so this pool is caller-provided (a workflow input), standing
 * in for the "fetch + open + look at it" step of the real tool.
 */
export const ImageCandidateSchema = z.object({
  path: z.string().min(1),
  description: z.string().min(1),
});
export type ImageCandidate = z.infer<typeof ImageCandidateSchema>;

/**
 * One slide's vetting verdict. `imagePath: null` means "no candidate in the
 * pool honestly satisfies this slide's need" — the legacy-defect fix RFC-03
 * §1 requires preserved exactly: a `null` here must hold the *whole* post
 * (`WorkflowHeld`), never ship with a placeholder or silently drop the slide.
 *
 * `license`/`rightsUsable`/`watermarkFree` (P0 parity-audit Fix 4) restore
 * carousel-agent-v2 SKILL.md step 06's real vetting requirement — "Is it
 * rights-usable, watermark-free, and of the right era? Record per image: the
 * source URL, the licence, and the check verdict" — which this schema used
 * to drop entirely (only `imagePath`/`reason` existed; a code *comment*
 * described the legacy requirement but it never reached the schema or the
 * prompt the model actually sees). Every selected image needs its own
 * verdict on all three, whether or not `imagePath` is null (a `null`
 * selection still records why nothing qualified, including rights/watermark
 * concerns if that's what disqualified a candidate). The workflow treats
 * `rightsUsable: false` or `watermarkFree: false` exactly like `imagePath:
 * null` — holding the whole post, never shipping a rights-encumbered or
 * watermarked image.
 */
export const ImageSelectionSchema = z.object({
  n: z.number().int().positive(),
  imagePath: z.string().min(1).nullable(),
  reason: z.string().min(1),
  /** The licence/source basis for this verdict (e.g. "CC0, Unsplash", "client-owned asset", "n/a — no candidate qualified"). */
  license: z.string().min(1),
  /** False when the candidate is not clear to use commercially (unclear/incompatible licence, unverifiable source, etc.) — never shipped regardless of visual fit. */
  rightsUsable: z.boolean(),
  /** False when the candidate carries a visible watermark, stock-site overlay, or other embedded marking — never shipped regardless of visual fit. */
  watermarkFree: z.boolean(),
});
export type ImageSelection = z.infer<typeof ImageSelectionSchema>;

export const ImageVettingOutputSchema = z.object({
  selections: z.array(ImageSelectionSchema).min(1),
});
export type ImageVettingOutput = z.infer<typeof ImageVettingOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Step 08b — post-render visual QA (InstagramVisualQaAgent's output)
// ─────────────────────────────────────────────────────────────────────────

/**
 * One `check: "render"` rule's verdict against a single rendered attempt.
 * `slide` is omitted for a whole-post-level rule (e.g. "never repeat a
 * picture across slides") that isn't about one specific slide.
 */
export const VisualQaFindingSchema = z.object({
  ruleId: z.string().min(1),
  slide: z.number().int().positive().optional(),
  passed: z.boolean(),
  note: z.string().min(1),
});
export type VisualQaFinding = z.infer<typeof VisualQaFindingSchema>;

/**
 * `InstagramVisualQaAgent`'s output (P0 parity-audit Fix 2) — carousel-agent-v2
 * SKILL.md step 08: "look at the PNGs... check the `check: 'render'` rules
 * from the frozen config: nothing overlapping, no near-empty slide, the
 * closer carries a device. A fail here is `RETURN: 05`." This repo has no
 * real vision-capable image-inspection tool wired in yet (the same
 * documented class of gap as `InstagramImageVettingAgent`'s own text-only
 * candidate judging), so this agent is a deliberate text-proxy stand-in: it
 * judges plausibility from the same structured `fields`/`images` data
 * `slides-data.json` carries, never actual pixels. `pass: false` routes the
 * workflow back through the SAME step-07 self-check retry loop (RETURN: 05
 * equivalent), not a separate mechanism.
 */
export const VisualQaOutputSchema = z.object({
  pass: z.boolean(),
  findings: z.array(VisualQaFindingSchema).default([]),
});
export type VisualQaOutput = z.infer<typeof VisualQaOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Step 07 — emit slides-data.json (the publish.renderCarousel input contract)
// ─────────────────────────────────────────────────────────────────────────

/** The result of step 07's self-check — mirrors `GateVerdictKind`'s pass/content_fail shape without pulling in the full `GateVerdict` union (this is workflow-internal, never a tool outcome). */
export type SlidesDataSelfCheck = { ok: true } | { ok: false; reason: string };

// ─────────────────────────────────────────────────────────────────────────
// Final workflow result
// ─────────────────────────────────────────────────────────────────────────

export interface InstagramAgentWorkflowResult {
  postId: string;
  topic: string;
  slideCount: number;
  renderedCount: number;
  deliverableId: string;
}
