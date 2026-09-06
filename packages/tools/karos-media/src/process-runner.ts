import { execFile } from "node:child_process";

/**
 * What one finished subprocess communicated: its two streams and its exit
 * code. `yt-dlp` (the only binary this package spawns today) reports a
 * search as JSON on stdout and a failure as prose on stderr with a non-zero
 * exit, so the provider reads both rather than assuming one channel.
 */
export interface ProcessResultLike {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Injectable so unit tests never need `yt-dlp` on the PATH — the same
 * discipline `karos-video` applies to its Python/ffmpeg scripts. Production
 * supplies {@link createDefaultProcessRunner}; tests supply a stub that
 * returns canned stdout/exit codes and asserts on the argv it was handed.
 *
 * Deliberately a LOCAL copy of `karos-video`'s `ProcessRunner` shape rather
 * than an import: `karos-video` is not a dependency of this package, and a
 * two-line type is not worth a cross-package edge that would pull the whole
 * video engine into every media consumer's build graph.
 */
export type ProcessRunnerLike = (command: string, args: readonly string[]) => Promise<ProcessResultLike>;

/**
 * Spawns via `execFile`, never a shell: every argument is its own array
 * element, so a client-supplied show name or topic inside a `ytsearch:` query
 * can never be read as shell syntax. `execFile` rejects on a non-zero exit,
 * but for `yt-dlp` a non-zero exit is an ordinary, expected report ("no
 * formats", "file larger than --max-filesize") that the provider must be able
 * to read — so it is unwrapped back into the same {@link ProcessResultLike}
 * a passing run produces. Only a genuine spawn failure (binary missing,
 * timeout, killed) stays a rejection, which the tool layer reports as
 * `tooling_error`.
 */
export function createDefaultProcessRunner(options: { timeoutMs?: number; maxBuffer?: number } = {}): ProcessRunnerLike {
  // A full-length podcast episode at 1080p is a multi-minute download.
  const timeout = options.timeoutMs ?? 10 * 60 * 1000;
  // `--dump-single-json` for a search page is tens of KB; the ceiling is for the download's progress chatter.
  const maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024;

  return (command, args) =>
    new Promise<ProcessResultLike>((resolve, reject) => {
      execFile(command, [...args], { timeout, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        const err = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        if (typeof err.code === "number") {
          resolve({ stdout, stderr, exitCode: err.code });
          return;
        }
        reject(error);
      });
    });
}
