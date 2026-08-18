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
}

export function resolveRunPaths(workDir: string): RunPaths {
  return {
    workDir,
    profilePath: path.join(workDir, "brand-profile.json"),
    transcriptPath: path.join(workDir, "transcript.json"),
    jobPath: path.join(workDir, "job.json"),
    outputPath: path.join(workDir, "edit", "final.mp4"),
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
 * A representative frame inside the sequence directory `graphic_qa.py`
 * globs (`seq_dir = (jdir / ov["file"]).parent; frames =
 * sorted(seq_dir.glob("*.png"))`, `graphic_qa.py:43-45`). Generating the
 * actual PNG sequence is `make_motion_repertoire.py`'s job — a per-client
 * script RFC-06 §5 lists as out of this migration's six-script scope — but
 * the DIRECTORY this plans against must still match where that generator
 * actually writes, or `graphic_qa.py` finds nothing and every real run fails
 * with "NO FRAMES FOUND" regardless of how good the plan was (P0#2 audit
 * finding). `make_motion_repertoire.template.py`'s own header states the
 * real convention verbatim: "Every graphic renders to
 * overlays/anim-<name>/%04d.png at 30fps." Editing artifacts otherwise all
 * live under `edit/` (`build_short.py`'s own docstring examples —
 * `edit/transcripts/...`, `edit/animations/...`), so `overlays/` is treated
 * as nested under the run's edit dir here; this placement (edit/overlays vs.
 * a job-root-level overlays/) is the one part of the convention
 * `make_motion_repertoire.template.py`'s comment doesn't pin down and
 * `build_short.py` itself was not read in full to confirm (RFC-06 §5) — an
 * index suffix is appended to `anim-<name>` (not in the template's literal
 * string) only to keep two overlays sharing one archetype from colliding.
 */
export function planToOverlays(plan: GraphicsPlanOutput, workDir: string): Overlay[] {
  return plan.overlays.map((o, i) => ({
    file: path.join(workDir, "edit", "overlays", `anim-${slug(o.archetype)}-${i}`, "0000.png"),
    start: o.start,
    end: o.end,
    ...(o.x !== undefined ? { x: o.x } : {}),
    ...(o.y !== undefined ? { y: o.y } : {}),
  }));
}

export function planToCutaways(plan: GraphicsPlanOutput, workDir: string): Cutaway[] {
  return plan.cutaways.map((c, i) => {
    if (c.kind === "burst") {
      const count = c.stillCount ?? 4;
      return {
        stills: Array.from({ length: count }, (_, s) => path.join(workDir, "edit", "burst", `${i}_${s}.png`)),
        start: c.start,
        end: c.end,
        word_src_start: c.wordSrcStart,
        phrase: c.phrase,
      };
    }
    return {
      file: path.join(workDir, "edit", "cutaway", String(i), "plate.png"),
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
  crop?: string;
}

/** Assembles `build_short.py`'s job spec (its own docstring) from every upstream stage's output. */
export function assembleJob(params: AssembleJobParams): VideoJob {
  return VideoJobSchema.parse({
    source: params.sourceVideoPath,
    transcript: params.paths.transcriptPath,
    edit_dir: path.join(params.paths.workDir, "edit"),
    output: params.paths.outputPath,
    ...(params.crop !== undefined ? { crop: params.crop } : {}),
    grade: params.grade,
    ...(params.fps !== undefined ? { fps: params.fps } : {}),
    ...(params.canvasScale !== undefined ? { canvas_scale: params.canvasScale } : {}),
    segments: params.segments,
    content_cuts: params.contentCuts,
    highlight_starts: params.highlightStarts,
    overlays: planToOverlays(params.plan, params.paths.workDir),
    cutaways: planToCutaways(params.plan, params.paths.workDir),
  });
}
