import { createDefaultProcessRunner, type ProcessRunner } from "./process/runner.js";

/** Shared factory options every `video.*` tool constructor accepts, mirroring `karos-reputation`'s `CreateReputationCaptureOptions` injectable pattern. */
export interface KarosVideoToolOptions {
  /** Injectable so tests never spawn a real process — see `process/runner.ts`. Defaults to a real `child_process.execFile`-backed runner. */
  runner?: ProcessRunner;
  /** Defaults to `env.KAROS_VIDEO_PYTHON_BIN` or `"python3"`. */
  pythonBin?: string;
  /** Defaults to `env.KAROS_VIDEO_FFPROBE_BIN` or `"ffprobe"` (`video.selfEvalGate` only). */
  ffprobeBin?: string;
  /**
   * A checkout of the branded-shorts product's `assets/engine/` directory.
   * RFC-06 §3/§8: this is a real vendoring decision this repo has not yet
   * made, so it is read from `BRANDED_SHORTS_ENGINE_DIR` rather than assumed
   * — every Python-wrapping tool below returns a `tooling_error` (never a
   * silent no-op) when neither this nor the env var is set.
   */
  engineDir?: string;
  /**
   * Absolute root under which `video.writeJsonFile`/`video.readJsonFile`
   * confine every call to `<workRoot>/<clientSlug>/…` (a security-audit
   * finding: these two tools otherwise accept an arbitrary path with no
   * tenant scoping — see `../sandbox.js`). Defaults to
   * `env.BRANDED_SHORTS_WORK_ROOT`. Left unconfigured, the two tools keep
   * accepting any non-traversal, non-NUL path unscoped, matching this
   * package's behavior before the sandbox existed — set this (or the env
   * var) to turn tenant confinement on.
   */
  workRoot?: string;
  /** Defaults to `process.env` — injectable so a workflow or a test can supply credentials without mutating the real process environment. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface KarosVideoRuntime {
  runner: ProcessRunner;
  pythonBin: string;
  ffprobeBin: string;
  engineDir?: string;
  workRoot?: string;
  env: Readonly<Record<string, string | undefined>>;
}

export function resolveRuntime(options: KarosVideoToolOptions): KarosVideoRuntime {
  const env = options.env ?? process.env;
  const engineDir = options.engineDir ?? env["BRANDED_SHORTS_ENGINE_DIR"];
  const workRoot = options.workRoot ?? env["BRANDED_SHORTS_WORK_ROOT"];
  return {
    runner: options.runner ?? createDefaultProcessRunner(),
    pythonBin: options.pythonBin ?? env["KAROS_VIDEO_PYTHON_BIN"] ?? "python3",
    ffprobeBin: options.ffprobeBin ?? env["KAROS_VIDEO_FFPROBE_BIN"] ?? "ffprobe",
    ...(engineDir !== undefined ? { engineDir } : {}),
    ...(workRoot !== undefined ? { workRoot } : {}),
    env,
  };
}

export type EngineScriptLookup = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Resolves one engine script's path from the configured `engineDir`. Never
 * throws — a missing `engineDir` is a configuration gap the tool call
 * reports as a `tooling_error`, per RFC-06 §3's "flag now rather than
 * discover mid-build" instruction.
 */
export function resolveEngineScript(runtime: KarosVideoRuntime, scriptName: string): EngineScriptLookup {
  if (!runtime.engineDir) {
    return {
      ok: false,
      reason:
        `no Branded Shorts engine directory configured — set BRANDED_SHORTS_ENGINE_DIR (or pass engineDir) to a ` +
        `checkout of the product's assets/engine/ before calling "${scriptName}" (RFC-06 §3/§8: this vendoring ` +
        `decision has not been made for this environment yet)`,
    };
  }
  const sep = runtime.engineDir.includes("\\") ? "\\" : "/";
  const trimmed = runtime.engineDir.replace(/[\\/]+$/, "");
  return { ok: true, path: `${trimmed}${sep}${scriptName}` };
}
