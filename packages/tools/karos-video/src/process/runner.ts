import { execFile } from "node:child_process";

/**
 * The result of running one Python engine script — mirrors what every
 * `assets/engine/*.py` script actually communicates: a human-readable report
 * on stdout/stderr and a 0/1 exit code (RFC-06 §2: none of these scripts
 * emit structured JSON). Every `video.*` gate wrapper parses `stdout`
 * defensively rather than assuming a machine-readable contract that doesn't
 * exist.
 */
export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Injectable so unit tests never need a real Python/ffmpeg/opencv
 * environment (RFC-06's testing discipline: ffmpeg, `lut3d`, and
 * `opencv-python-headless<5` are external container dependencies, not
 * `npm install`-able — see RFC-06 §3). Production wiring supplies
 * {@link createDefaultProcessRunner}; tests supply a `vi.fn()` stub that
 * returns canned stdout/exit codes and asserts on the args it was called
 * with.
 */
export type ProcessRunner = (command: string, args: string[]) => Promise<ProcessResult>;

/**
 * Spawns a real subprocess via `execFile` (never a shell — every argument is
 * passed as its own array element, so a client-supplied path or profile
 * value can never be interpreted as shell syntax). `execFile` rejects on a
 * non-zero exit code; every one of this product's gate scripts uses exit
 * code 1 to mean "FAIL," which is a normal, expected outcome here, not a
 * thrown error — so the rejection is caught and its `code`/`stdout`/`stderr`
 * are unwrapped back into the same {@link ProcessResult} shape a passing run
 * would have produced.
 */
export function createDefaultProcessRunner(options: { timeoutMs?: number; maxBuffer?: number } = {}): ProcessRunner {
  const timeout = options.timeoutMs ?? 10 * 60 * 1000; // build_short.py is a multi-minute CPU-bound encode (RFC-06 §3)
  const maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024;

  return (command, args) =>
    new Promise<ProcessResult>((resolve, reject) => {
      execFile(command, args, { timeout, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        const err = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        if (typeof err.code === "number") {
          // Non-zero exit — a normal FAIL/error report from the script, not a tooling exception.
          resolve({ stdout, stderr, exitCode: err.code });
          return;
        }
        // Spawn failure (binary missing, ENOENT, timeout, killed) — genuinely exceptional.
        reject(error);
      });
    });
}
