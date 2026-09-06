import * as path from "node:path";
import { VideoJobSchema, type Cutaway, type Overlay, type VideoJob, type VideoSegment } from "@agent-engine/tool-karos-video";
import type { GraphicsPlanOutput } from "./types.js";

/**
 * Pure assembly only — no I/O. Writing the result to disk goes through
 * `video.writeJsonFile` (a Layer 3 tool), so the workflow's `step.code`
 * callbacks stay consistent with every other migrated agent's "all I/O
 * through tools" convention rather than reaching around it with a raw
 * `node:fs` call from workflow code.
 */

/**
 * Real files a local Python subprocess can open (RFC-06 §3/§4's "adapter,
 * never infra": ffmpeg/PIL never read from the abstract WorkspaceStore).
 * Every path this module writes into a job is absolute — Python's
 * `PurePath.__truediv__` (`jdir / value`) discards the left side entirely
 * when `value` is already absolute, so this sidesteps ever having to prove
 * which job fields `build_short.py` resolves relative to the job file and
 * which it doesn't.
 */
export interface RunPaths {
  workDir: string;
  profilePath: string;
  transcriptPath: string;
  jobPath: string;
  outputPath: string;
  /** `build_short.py --until base`'s output: the graded, concatenated footage timeline `graphic_qa.py` gates overlays against. */
  basePath: string;
}

export function resolveRunPaths(workDir: string): RunPaths {
  return {
    workDir,
    profilePath: path.join(workDir, "brand-profile.json"),
    transcriptPath: path.join(workDir, "transcript.json"),
    jobPath: path.join(workDir, "job.json"),
    outputPath: path.join(workDir, "edit", "final.mp4"),
    basePath: path.join(workDir, "edit", "base.mp4"),
  };
}

/** Slugifies an archetype name into a filesystem-safe directory segment. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * The frame-sequence PATTERN inside the directory `render_overlays.py` writes
 * and `graphic_qa.py` globs (`seq_dir = (jdir / ov["file"]).parent`).
 *
 * `make_motion_repertoire.template.py`'s own header states the convention
 * verbatim: "Every graphic renders to overlays/anim-<name>/%04d.png at
 * 30fps." The `%04d` is load-bearing on BOTH consumers: `build_short.py`
 * treats a `file` containing `%` as an image sequence (time-shifted,
 * animated) and anything else as one static PNG, and `graphic_qa.py` used
 * to skip non-`%` overlays entirely. An earlier version of this function
 * wrote `0000.png` here, so every planned graphic would have been
 * composited as a frozen first frame AND excused from the graphics gate —
 * two silent failures from one wrong filename.
 *
 * Editing artifacts otherwise all live under `edit/` (`build_short.py`'s own
 * docstring examples), so `overlays/` sits under the run's edit dir; the
 * index suffix on `anim-<name>` keeps two overlays sharing one archetype
 * from colliding. `archetype` and `label` ride along for the renderer.
 */
export function planToOverlays(plan: GraphicsPlanOutput, workDir: string): Overlay[] {
  return plan.overlays.map((o, i) => ({
    file: path.join(workDir, "edit", "overlays", `anim-${slug(o.archetype)}-${i}`, "%04d.png"),
    start: o.start,
    end: o.end,
    archetype: o.archetype,
    ...(o.label !== undefined ? { label: o.label } : {}),
    ...(o.x !== undefined ? { x: o.x } : {}),
    ...(o.y !== undefined ? { y: o.y } : {}),
  }));
}

export interface PlanToCutawaysOptions {
  /** Per-cutaway-index absolute path of the generated plate (from `image.generate`). A plate with no entry keeps the default `edit/cutaway/<i>/plate.png` location. */
  plateFiles?: Readonly<Record<number, string>>;
  /** Root the plan's library-relative `stills[]` resolve against — the directory holding the client's `brand-profile.json`. */
  libraryRoot?: string;
}

export function planToCutaways(plan: GraphicsPlanOutput, workDir: string, options: PlanToCutawaysOptions = {}): Cutaway[] {
  return plan.cutaways.map((c, i) => {
    if (c.kind === "burst") {
      const stills =
        c.stills && c.stills.length > 0
          ? c.stills.map((s) => (options.libraryRoot !== undefined ? path.join(options.libraryRoot, s) : s))
          : Array.from({ length: c.stillCount ?? 4 }, (_, s) => path.join(workDir, "edit", "burst", `${i}_${s}.png`));
      return {
        stills,
        start: c.start,
        end: c.end,
        word_src_start: c.wordSrcStart,
        phrase: c.phrase,
      };
    }
    return {
      file: options.plateFiles?.[i] ?? path.join(workDir, "edit", "cutaway", String(i), "plate.png"),
      start: c.start,
      end: c.end,
      word_src_start: c.wordSrcStart,
      phrase: c.phrase,
    };
  });
}

export interface AssembleJobParams {
  paths: RunPaths;
  sourceVideoPath: string;
  grade: string;
  segments: VideoSegment[];
  contentCuts: VideoJob["content_cuts"];
  highlightStarts: number[];
  plan: GraphicsPlanOutput;
  canvasScale?: number;
  fps?: number;
  /**
   * Framing. Defaults to `"auto"` — SKILL.md step 2's "Auto-center framing
   * (crop:"auto", face detection on decoded frames)": `build_short.py`
   * detects the face and derives a 9:16 crop centred on it, then scales to
   * the canvas. Without ANY crop the engine emits no scale filter at all, so
   * a landscape or 4K source would be composited at its native geometry
   * under 1080-wide captions.
   */
  crop?: string;
  /** Intake Q8: replaces the endcard eyebrow text for this run only. */
  endcardOverride?: string;
  /** Intake Q7: per-run ASR spelling fixes, merged over the profile's by the engine. */
  corrections?: Record<string, string>;
  plateFiles?: Readonly<Record<number, string>>;
  libraryRoot?: string;
}

/** Assembles `build_short.py`'s job spec (its own docstring) from every upstream stage's output. */
export function assembleJob(params: AssembleJobParams): VideoJob {
  return VideoJobSchema.parse({
    source: params.sourceVideoPath,
    transcript: params.paths.transcriptPath,
    edit_dir: path.join(params.paths.workDir, "edit"),
    output: params.paths.outputPath,
    crop: params.crop ?? "auto",
    grade: params.grade,
    ...(params.fps !== undefined ? { fps: params.fps } : {}),
    ...(params.canvasScale !== undefined ? { canvas_scale: params.canvasScale } : {}),
    segments: params.segments,
    content_cuts: params.contentCuts,
    highlight_starts: params.highlightStarts,
    overlays: planToOverlays(params.plan, params.paths.workDir),
    cutaways: planToCutaways(params.plan, params.paths.workDir, {
      ...(params.plateFiles !== undefined ? { plateFiles: params.plateFiles } : {}),
      ...(params.libraryRoot !== undefined ? { libraryRoot: params.libraryRoot } : {}),
    }),
    ...(params.corrections !== undefined && Object.keys(params.corrections).length > 0 ? { corrections: params.corrections } : {}),
    ...(params.endcardOverride !== undefined ? { endcard_override: params.endcardOverride } : {}),
  });
}
