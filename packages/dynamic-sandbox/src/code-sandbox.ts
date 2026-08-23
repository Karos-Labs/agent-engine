import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_GUARD_SOURCE, PYTHON_GUARD_SOURCE } from "./sandbox-guards.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const HARD_TIMEOUT_CAP_MS = 120_000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024; // 2 MB — a code step returns a JSON object, not a media file
const MAX_MEMORY_MB = 512;
const MAX_FILE_SIZE_BLOCKS = 20_480; // ulimit -f is in 512-byte blocks → 10 MB
const MAX_PIDS = 64;
const MAX_STDERR_CHARS = 20_000;

export type SandboxTier = "docker" | "local";

export interface CodeStepResult {
  ok: boolean;
  /** Parsed JSON object from stdout, when ok. */
  output?: unknown;
  /** stdout/stderr tail + reason, when !ok. */
  error?: string;
  stderr?: string;
  timedOut?: boolean;
  /** Which tier actually executed this step — recorded so a run is auditable. */
  tier?: SandboxTier;
}

/**
 * Runs one Dynamic Agent Studio code step.
 *
 * // DECISION: code steps ship behind DYNAMIC_CODE_STEPS_ENABLED (default
 * off), because sandbox hardening has not had a security review. The gate
 * itself lives one level up in step-runner.ts, which never calls this function
 * unless the flag is on.
 *
 * TWO TIERS, because Phase 7's hard requirements (no network egress,
 * read-only filesystem except a tmpfs scratch dir, non-root, wall-clock
 * timeout, memory cap, stdout size cap) need kernel-level controls that a
 * non-root process inside an already-running container cannot grant itself:
 *
 *  1. `docker` — used when DYNAMIC_CODE_SANDBOX_IMAGE is set and a Docker
 *     daemon answers. Every hard requirement is met by the kernel:
 *       no network egress   → `--network none` (no interface at all)
 *       read-only fs        → `--read-only` plus `--tmpfs /scratch` as the one
 *                             writable mount (noexec, nosuid, size-capped)
 *       non-root            → `--user 10001:10001`, `--cap-drop ALL`,
 *                             `--security-opt no-new-privileges`
 *       memory cap          → `--memory` / `--memory-swap` (a real cgroup)
 *       fork-bomb cap       → `--pids-limit`
 *       wall-clock timeout  → enforced here, plus `docker kill`
 *       stdout cap          → enforced here
 *     This is the tier to run in production; `deploy/` sets the image.
 *
 *  2. `local` — the fallback when no daemon is reachable (today's Cloud Run
 *     runner). Enforced with what a non-root process genuinely CAN impose:
 *       non-root            → REAL, inherited (runner/Dockerfile runs as
 *                             `agent`, uid 10001)
 *       wall-clock timeout  → REAL (SIGKILL here, hard cap 120s)
 *       stdout cap          → REAL (killed the instant it is crossed)
 *       CPU-time cap        → REAL (`ulimit -t`, kernel-enforced)
 *       file-size cap       → REAL (`ulimit -f`, kernel-enforced)
 *       memory cap          → REAL for Python (`ulimit -v`, i.e. RLIMIT_AS);
 *                             for Node it is `--max-old-space-size`, a V8 heap
 *                             cap rather than total RSS, because `ulimit -v`
 *                             makes V8 abort at startup (it reserves a large
 *                             virtual range) — verified, not assumed.
 *       process-count cap    → `ulimit -u` (fork-bomb backstop; belt-and-
 *                             braces alongside the guards below, which block
 *                             `os.fork`/`spawn*`/`exec*` outright for Python
 *                             and never expose `child_process` to Node).
 *       no network egress   → BEST-EFFORT at the interpreter level: the
 *                             guards in sandbox-guards.ts block `require()`
 *                             AND dynamic `import()` (via a `module.register`
 *                             loader hook — the two have separate resolution
 *                             pipelines and both must be covered) of `net`/
 *                             `http`/`https`/`tls`/`dgram`/`dns`/
 *                             `child_process` (Node) and `socket`/`ssl`/
 *                             `urllib`/`http`/`subprocess`/`ctypes` (Python),
 *                             neuter `fetch`, and disable the whole os-level
 *                             process-spawning family (`system`, `popen`,
 *                             `fork`, `exec*`, `spawn*`) so a step can't shell
 *                             out to curl/wget either. This is a blocklist,
 *                             not a firewall: it stops every network/spawn
 *                             primitive we've identified in either language's
 *                             standard surface, not a native exploit of the
 *                             interpreter, and a blocklist can in principle
 *                             miss a primitive we haven't thought of — which
 *                             is exactly why this is the FALLBACK tier and the
 *                             docker tier's kernel-level `--network none` is
 *                             the one to trust for production.
 *       read-only fs        → REAL at the interpreter level for the same
 *                             reason: every write entry point is wrapped to
 *                             refuse a path outside the scratch dir
 *                             (symlink-resolved), so the step can only write
 *                             where it is supposed to. The rest of the
 *                             filesystem is not kernel-level read-only, which
 *                             is precisely what the docker tier fixes.
 *
 * Both tiers share the contract: context in on stdin as JSON, one JSON object
 * out on stdout, stderr captured into the failure record; a non-zero exit,
 * invalid JSON, a non-object, an over-cap stdout, or a timeout fails the step.
 */
export async function runCodeStep(args: {
  language: "python" | "node";
  code: string;
  context: unknown;
  timeoutMs?: number;
}): Promise<CodeStepResult> {
  const timeoutMs = Math.min(Math.max(1, args.timeoutMs ?? DEFAULT_TIMEOUT_MS), HARD_TIMEOUT_CAP_MS);
  const image = dockerSandboxImage();
  const tier: SandboxTier = image && dockerDaemonAvailable() ? "docker" : "local";

  const scratchDir = await mkdtemp(join(tmpdir(), "dynamic-code-"));
  try {
    const scriptName = args.language === "python" ? "step.py" : "step.js";
    const guardName = args.language === "python" ? "__karos_guard.py" : "__karos_guard.cjs";
    const guardSource = args.language === "python" ? PYTHON_GUARD_SOURCE : NODE_GUARD_SOURCE;
    await writeFile(join(scratchDir, scriptName), args.code, "utf8");
    await writeFile(join(scratchDir, guardName), guardSource, "utf8");

    const invocation =
      tier === "docker"
        ? dockerInvocation({
            image: image as string,
            language: args.language,
            scriptName,
            guardName,
            timeoutMs,
            codeB64: Buffer.from(args.code, "utf8").toString("base64"),
            guardB64: Buffer.from(guardSource, "utf8").toString("base64"),
          })
        : localInvocation({ language: args.language, scratchDir, scriptName, guardName, timeoutMs });

    const result = await execute({
      command: invocation.command,
      commandArgs: invocation.commandArgs,
      cwd: tier === "docker" ? scratchDir : scratchDir,
      env: invocation.env,
      stdin: JSON.stringify(args.context ?? {}),
      timeoutMs,
      onTimeoutKill: invocation.onTimeoutKill,
    });
    return { ...result, tier };
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ────────────────────────── tier selection ────────────────────────── */

function dockerSandboxImage(): string | undefined {
  const image = process.env.DYNAMIC_CODE_SANDBOX_IMAGE;
  return image && image.trim().length > 0 ? image.trim() : undefined;
}

let dockerProbe: boolean | undefined;
/**
 * Probed once per process, not per step: `docker version` costs a fork and the
 * answer cannot change while the runner is alive. Exported for tests to reset.
 */
export function dockerDaemonAvailable(): boolean {
  if (dockerProbe !== undefined) return dockerProbe;
  try {
    const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5_000,
    });
    dockerProbe = probe.status === 0;
  } catch {
    dockerProbe = false;
  }
  return dockerProbe;
}

export function __resetDockerProbeForTests(): void {
  dockerProbe = undefined;
}

/* ────────────────────────── invocations ────────────────────────── */

interface Invocation {
  command: string;
  commandArgs: string[];
  env: Record<string, string>;
  onTimeoutKill?: () => void;
}

/**
 * The docker tier. The scratch dir is a `--tmpfs` mount, so the host copy of
 * the script cannot simply be bind-mounted in (a bind mount of a host path
 * would also be a way out of the sandbox). Instead both files travel as
 * base64 ARGV to a tiny `sh` bootstrap that materializes them onto the tmpfs
 * and execs the interpreter — argv is visible only inside this throwaway
 * container, and it carries the author's own code, not a secret.
 */
export function dockerInvocation(args: {
  image: string;
  language: "python" | "node";
  scriptName: string;
  guardName: string;
  timeoutMs: number;
  codeB64: string;
  guardB64: string;
}): Invocation {
  const containerName = `karos-code-step-${process.pid}-${Date.now().toString(36)}`;
  const cpuSeconds = Math.max(1, Math.ceil(args.timeoutMs / 1000));
  const interpreter =
    args.language === "python"
      ? `exec python3 /scratch/${args.guardName} /scratch/${args.scriptName}`
      : `exec node --max-old-space-size=${MAX_MEMORY_MB} --require /scratch/${args.guardName} /scratch/${args.scriptName}`;

  const bootstrap = [
    `set -e`,
    `printf %s "$1" | base64 -d > /scratch/${args.scriptName}`,
    `printf %s "$2" | base64 -d > /scratch/${args.guardName}`,
    `ulimit -f ${MAX_FILE_SIZE_BLOCKS} 2>/dev/null || true`,
    `ulimit -t ${cpuSeconds} 2>/dev/null || true`,
    interpreter,
  ].join("\n");

  return {
    command: "docker",
    commandArgs: [
      "run",
      "--rm",
      "-i",
      "--name",
      containerName,
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/scratch:rw,noexec,nosuid,size=64m",
      "--user",
      "10001:10001",
      "--memory",
      `${MAX_MEMORY_MB}m`,
      "--memory-swap",
      `${MAX_MEMORY_MB}m`,
      "--pids-limit",
      String(MAX_PIDS),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "-w",
      "/scratch",
      "-e",
      "KAROS_SANDBOX_SCRATCH=/scratch",
      "-e",
      "HOME=/scratch",
      "-e",
      "TMPDIR=/scratch",
      args.image,
      "sh",
      "-c",
      bootstrap,
      "_", // $0 for the bootstrap; the two payloads below become $1 and $2
      args.codeB64,
      args.guardB64,
    ],
    env: {},
    onTimeoutKill: () => {
      // `docker run --rm` leaves the container behind if the client is killed;
      // kill it by name so a timed-out step can't outlive its own job.
      try {
        spawnSync("docker", ["kill", containerName], { stdio: "ignore", timeout: 10_000 });
      } catch {
        /* best effort */
      }
    },
  };
}

/**
 * The local tier. Wrapped in `sh -c` purely to get the kernel rlimits, which
 * only a shell (or a native setrlimit call) can set before exec.
 *
 * `ulimit -v` is applied for PYTHON ONLY: V8 reserves a large virtual address
 * space at startup and aborts under RLIMIT_AS, so Node gets `--max-old-space-size`
 * instead. Verified empirically, not assumed — see the module doc.
 */
export function localInvocation(args: {
  language: "python" | "node";
  scratchDir: string;
  scriptName: string;
  guardName: string;
  timeoutMs: number;
}): Invocation {
  const cpuSeconds = Math.max(1, Math.ceil(args.timeoutMs / 1000));
  const limits = [
    `ulimit -f ${MAX_FILE_SIZE_BLOCKS} 2>/dev/null || true`,
    `ulimit -t ${cpuSeconds} 2>/dev/null || true`,
    `ulimit -u ${MAX_PIDS} 2>/dev/null || true`,
  ];
  let exec: string;
  if (args.language === "python") {
    limits.push(`ulimit -v ${MAX_MEMORY_MB * 1024} 2>/dev/null || true`);
    exec = `exec python3 "$1" "$2"`;
  } else {
    exec = `exec node --max-old-space-size=${MAX_MEMORY_MB} --require "$1" "$2"`;
  }
  return {
    command: "sh",
    commandArgs: [
      "-c",
      [...limits, exec].join("\n"),
      "_",
      join(args.scratchDir, args.guardName),
      join(args.scratchDir, args.scriptName),
    ],
    env: sandboxEnv(args.scratchDir),
  };
}

/**
 * Built from an EMPTY allowlist rather than by filtering `process.env`: the
 * runner's own environment holds the Anthropic key, the job's runner token and
 * the proxy configuration that is the only route to the network in this image.
 * A code step gets none of it — PATH/LANG to run at all, and HOME/TMPDIR/
 * KAROS_SANDBOX_SCRATCH pointed at its own scratch dir so anything that wants
 * a temp file lands where the guard allows writes.
 */
function sandboxEnv(scratchDir: string): Record<string, string> {
  const env: Record<string, string> = {
    KAROS_SANDBOX_SCRATCH: scratchDir,
    HOME: scratchDir,
    TMPDIR: scratchDir,
  };
  for (const key of ["PATH", "LANG"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/* ────────────────────────── execution ────────────────────────── */

async function execute(args: {
  command: string;
  commandArgs: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  timeoutMs: number;
  onTimeoutKill?: (() => void) | undefined;
}): Promise<Omit<CodeStepResult, "tier">> {
  return await new Promise<Omit<CodeStepResult, "tier">>((resolve) => {
    const child = spawn(args.command, args.commandArgs, {
      cwd: args.cwd,
      env: args.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutOverflowed = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      args.onTimeoutKill?.();
      child.kill("SIGKILL");
    }, args.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutOverflowed) return;
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
        stdoutOverflowed = true;
        args.onTimeoutKill?.();
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // Bounded independently — stderr is diagnostics for the failure record,
      // not the deliverable, so it gets a much smaller cap.
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `Could not start the code step: ${err.message}`, stderr });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, error: `Code step timed out after ${args.timeoutMs}ms.`, stderr, timedOut: true });
        return;
      }
      if (stdoutOverflowed) {
        resolve({ ok: false, error: `Code step's stdout exceeded ${MAX_STDOUT_BYTES} bytes.`, stderr });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, error: `Code step exited with code ${code}.`, stderr });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          resolve({ ok: false, error: "Code step's stdout was valid JSON but not a JSON object.", stderr });
          return;
        }
        resolve({ ok: true, output: parsed, stderr });
      } catch {
        resolve({ ok: false, error: "Code step's stdout was not valid JSON.", stderr });
      }
    });

    child.stdin.write(args.stdin);
    child.stdin.end();
  });
}
