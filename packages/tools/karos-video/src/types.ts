import { z } from "zod";
import { GateVerdictSchema, type GateVerdict } from "@agent-engine/core";

export { GateVerdictSchema };
export type { GateVerdict };

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected a 6-digit hex color");

/**
 * The subset of `brand-profile.json`'s `color` block every gate script reads
 * (`brand_check.py`'s `palette_from_profile`, `graphic_qa.py`'s ink/accent
 * reads). `surface_1`/`surface_2`/`border`/`muted_foreground` are optional —
 * `palette_from_profile` only includes whichever of the eight keys exist.
 */
export const BrandColorPaletteSchema = z
  .object({
    // No existing TSDoc on these individual color fields to transcribe (SCRUM-293 flag) — synthesized from the schema's own doc comment and each gate script's usage.
    background: HexColor.describe("Base background color, 6-digit hex — read by brand_check.py's palette_from_profile."),
    foreground: HexColor.describe("Primary foreground/text color, 6-digit hex — read by brand_check.py's palette_from_profile."),
    accent: HexColor.describe("Accent color, 6-digit hex — read by brand_check.py's palette_from_profile and graphic_qa.py's ink/accent checks."),
    ink: HexColor.optional().describe("Optional ink color, 6-digit hex — read by graphic_qa.py's ink/accent checks when present."),
    surface_1: HexColor.optional().describe("Optional first surface color, 6-digit hex."),
    surface_2: HexColor.optional().describe("Optional second surface color, 6-digit hex."),
    border: HexColor.optional().describe("Optional border color, 6-digit hex."),
    muted_foreground: HexColor.optional().describe("Optional muted-foreground color, 6-digit hex."),
  })
  .passthrough();
export type BrandColorPalette = z.infer<typeof BrandColorPaletteSchema>;

/**
 * The client's `brand-profile.json` (SKILL.md step 0 / PLAYBOOK §1). Loose
 * shape, same convention as every other `client.*` config in this repo — no
 * canonical schema exists anywhere for it yet (RFC-06 §5 lists it as read
 * only structurally, never fully audited). Only the fields the gate scripts
 * actually read (`color.*`) are asserted; font paths, keyword device,
 * endcard, and locked-style fields pass through untouched for the Python
 * engine to interpret.
 */
export const BrandProfileSchema = z
  .object({
    // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from the schema's own doc comment.
    color: BrandColorPaletteSchema.describe("The client's brand color palette (brand-profile.json's color block) — the subset every gate script reads."),
    video_grade: z.string().min(1).optional().describe("PLAYBOOK §4b: a locked grade override; absent means \"auto\"."),
    video_captions_v2: z.record(z.string(), z.unknown()).optional().describe("PLAYBOOK §2: a profile without this block does not build (v2-only)."),
  })
  .passthrough();
export type BrandProfile = z.infer<typeof BrandProfileSchema>;

export const VideoSegmentSchema = z.tuple([z.number().nonnegative(), z.number().nonnegative()]);
export type VideoSegment = z.infer<typeof VideoSegmentSchema>;

/** cut_check.py's HONESTY check: a legitimate non-filler cut must be declared here, never silent. */
export const ContentCutSchema = z.object({
  span: VideoSegmentSchema,
  reason: z.string().min(1),
});
export type ContentCut = z.infer<typeof ContentCutSchema>;

/** A motion-graphic overlay window (`build_short.py`/`graphic_qa.py`/`cutaway_check.py`'s `overlays[]`). */
export const OverlaySchema = z
  .object({
    file: z.string().min(1),
    start: z.number().nonnegative(),
    end: z.number().positive(),
    x: z.union([z.literal("center"), z.number()]).optional(),
    y: z.number().optional(),
  })
  .passthrough();
export type Overlay = z.infer<typeof OverlaySchema>;

export const BurstSfxSchema = z.object({
  first: z.string().optional(),
  rest: z.string().optional(),
  gain_first: z.number().optional(),
  gain_rest: z.number().optional(),
});
export type BurstSfx = z.infer<typeof BurstSfxSchema>;

/**
 * `cutaway_check.py`'s job-level cutaway entry: either a single AI-generated
 * plate (`file`) or a v2 burst of 3-6 real stills (`stills`) — PLAYBOOK §4d,
 * never both, never neither.
 */
export const CutawaySchema = z
  .object({
    file: z.string().min(1).optional(),
    stills: z.array(z.string().min(1)).min(3).max(6).optional(),
    start: z.number().nonnegative(),
    end: z.number().positive(),
    word_src_start: z.number().nonnegative(),
    phrase: z.string().min(1),
    sfx: BurstSfxSchema.optional(),
    suppress: z.array(VideoSegmentSchema).optional(),
  })
  .refine((v) => (v.file !== undefined) !== (v.stills !== undefined), {
    message: "a cutaway is either a single plate (`file`) or a burst (`stills`), never both or neither",
  });
export type Cutaway = z.infer<typeof CutawaySchema>;

/**
 * `build_short.py`'s job spec (its own docstring, lines 11-35), reconstructed
 * here as a typed shape the agent workflow assembles before writing it to
 * disk and handing every `video.*` tool the resulting path — the tools
 * themselves never receive this object directly (RFC-06 §6's "adapter,
 * never infra": paths in, paths out, exactly like the underlying CLIs).
 */
export const VideoJobSchema = z
  .object({
    source: z.string().min(1),
    transcript: z.string().min(1),
    edit_dir: z.string().min(1).default("edit"),
    output: z.string().min(1),
    crop: z.string().optional(),
    grade: z.string().min(1),
    fps: z.number().positive().optional(),
    canvas_scale: z.number().positive().optional(),
    segments: z.array(VideoSegmentSchema).min(1),
    content_cuts: z.array(ContentCutSchema).default([]),
    highlight_starts: z.array(z.number().nonnegative()).default([]),
    overlays: z.array(OverlaySchema).default([]),
    cutaways: z.array(CutawaySchema).default([]),
  })
  .passthrough();
export type VideoJob = z.infer<typeof VideoJobSchema>;

/** One ElevenLabs Scribe word-level token (`cut_check.py`'s `spoken_words` reads `type`/`text`/`start`/`end`). */
export const TranscriptWordSchema = z
  .object({
    type: z.string(),
    text: z.string(),
    start: z.number(),
    end: z.number(),
  })
  .passthrough();
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;

export const VideoTranscriptSchema = z
  .object({
    words: z.array(TranscriptWordSchema),
  })
  .passthrough();
export type VideoTranscript = z.infer<typeof VideoTranscriptSchema>;
