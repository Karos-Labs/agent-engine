import type { GcsArtifactStoreLike } from "@agent-engine/tool-common";
import type { KarosVideoToolOptions } from "./config.js";
import { createAssetsCheck } from "./tools/assets-check.js";
import { createBrandGate } from "./tools/brand-gate.js";
import { createColorGrade } from "./tools/color-grade.js";
import { createCutGate } from "./tools/cut-gate.js";
import { createCutawayGate } from "./tools/cutaway-gate.js";
import { createGraphicsGate } from "./tools/graphics-gate.js";
import { createRender } from "./tools/render.js";
import { createReadJsonFile } from "./tools/read-json-file.js";
import { createSelfEvalGate } from "./tools/self-eval-gate.js";
import { createTranscribe, type CreateTranscribeOptions } from "./tools/transcribe.js";
import { createUploadDeliverable } from "./tools/upload-deliverable.js";
import { createWriteJsonFile } from "./tools/write-json-file.js";

export * from "./types.js";
export * from "./config.js";
export * from "./process/runner.js";
export * from "./gate-helpers.js";
export * from "./tools/assets-check.js";
export * from "./tools/brand-gate.js";
export * from "./tools/color-grade.js";
export * from "./tools/cut-gate.js";
export * from "./tools/cutaway-gate.js";
export * from "./tools/graphics-gate.js";
export * from "./tools/read-json-file.js";
export * from "./tools/render.js";
export * from "./tools/self-eval-gate.js";
export * from "./tools/transcribe.js";
export * from "./tools/upload-deliverable.js";
export * from "./tools/write-json-file.js";

export interface CreateKarosVideoToolsOptions extends KarosVideoToolOptions {
  transcribe?: CreateTranscribeOptions;
  /**
   * Wire this (via `GCS_MEDIA_BUCKET` at your composition root) to register
   * `video.uploadDeliverable`. Omitted, this package's behavior is exactly
   * what it was before Task 1 (RFC-01's GCS media store) — the tool simply
   * isn't in the returned registry, which is how
   * `create-branded-shorts-agent-workflow.ts`'s own optional upload step
   * tells "GCS is configured" apart from "it isn't."
   */
  mediaStore?: GcsArtifactStoreLike;
}

/**
 * The full `video.*` registry (RFC-06 §6) — every wrapper shares the same
 * injected `runner`/`pythonBin`/`ffprobeBin`/`engineDir` so a workflow or a
 * test configures the Python engine checkout once, not per tool.
 */
export function createKarosVideoTools(options: CreateKarosVideoToolsOptions = {}) {
  return {
    "video.assetsCheck": createAssetsCheck(options),
    "video.cutGate": createCutGate(options),
    "video.brandGate": createBrandGate(options),
    "video.graphicsGate": createGraphicsGate(options),
    "video.cutawayGate": createCutawayGate(options),
    "video.colorGrade": createColorGrade(),
    "video.render": createRender(options),
    "video.selfEvalGate": createSelfEvalGate(options),
    "video.transcribe": createTranscribe({ ...(options.env !== undefined ? { env: options.env } : {}), ...options.transcribe }),
    "video.writeJsonFile": createWriteJsonFile(options),
    "video.readJsonFile": createReadJsonFile(options),
    ...(options.mediaStore ? { "video.uploadDeliverable": createUploadDeliverable(options.mediaStore) } : {}),
  };
}
