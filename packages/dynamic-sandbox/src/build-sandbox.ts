import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_OUTPUT_CHARS = 200_000;
const DEFAULT_BUILD_TIMEOUT_MS = 300_000;

export type BuildSandboxTier = "docker" | "local";

/**
 * The ONLY variables a sandboxed build inherits from the engine process.
 *
 * Built as an ALLOWLIST, never as a deny-list, for the reason
 * `code-sandbox.ts`'s `sandboxEnv` gives: a deny-list has to enumerate every
 * secret the engine will ever hold, and the next credential added to the
 * runtime is leaked by default. Here the default is "dropped", and adding a
 * variable to the build's environment is a visible edit to this array.
 *
 * Every entry is a WHOLE NAME. There is deliberately no prefix matching —
 * an `npm_config_*` prefix rule would look tidy and would sweep in
 * `npm_config_//registry.npmjs.org/:_authToken`, which is exactly the class
 * of thing this list exists to keep out.
 *
 * What is NOT here, and why:
 *   - every credential (ANTHROPIC_API_KEY, GOOGLE_APPLICATION_CREDENTIALS,
 *     FIREBASE_SERVICE_ACCOUNT_KEY, PUBSUB_*, GCS_*, AUTH_*): the point.
 *   - HTTP_PROXY/HTTPS_PROXY/NO_PROXY and their lowercase spellings: the
 *     build inherits no egress configuration. A build that genuinely needs
 *     the network gets it named explicitly via `extraEnv`, per call.
 *   - NODE_OPTIONS: it can carry `--require`, which would pull engine code
 *     into the build process — the opposite of what this is for.
 *   - HOME/TMPDIR: NOT inherited; they are REPLACED below with the scratch
 *     dir, so the well-known credential file paths that hang off `$HOME`
 *     (`~/.config/gcloud/application_default_credentials.json`, `~/.npmrc`,
 *     `~/.docker/config.json`) resolve to an empty directory instead.
 */
export const BUILD_ENV_ALLOWLIST: readonly string[] = [
  "PATH", // finding node/npm at all
  "LANG", // locale-sensitive output
  "LC_ALL",
  "TZ",
  "NODE_ENV", // `next build` reads it
  "SystemRoot", // Windows: spawn fails outright without these two
  "COMSPEC",
];

/**
 * Fixed variables the sandbox SETS (they are not read from `process.env`).
 * `npm_config_offline` makes the npm client itself refuse to reach the
 * registry, so a model-authored `package.json` build script cannot quietly
 * pull a package mid-build.
 */
function sandboxFixedEnv(scratchDir: string): Record<string, string> {
  return {
    HOME: scratchDir,
    TMPDIR: scratchDir,
    KAROS_BUILD_SANDBOX: "1",
    npm_config_cache: join(scratchDir, "npm-cache"),
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

/**
 * The environment a sandboxed build actually runs with.
 *
 * @param scratchDir  a throwaway directory that becomes the build's HOME and
 *                    TMPDIR — it must NOT be the site directory.
 * @param extraEnv    variables the caller is deliberately granting for this
 *                    one build. Named per call so a grant is reviewable at
 *                    the call site; `undefined` values are dropped.
 * @param sourceEnv   the environment to read the allowlist from. Injectable
 *                    so the allowlist itself is testable without mutating
 *                    the test runner's own `process.env`.
 */
export function buildSandboxEnv(args: {
  scratchDir: string;
  extraEnv?: Record<string, string | undefined> | undefined;
  sourceEnv?: NodeJS.ProcessEnv | undefined;
}): Record<string, string> {
  const source = args.sourceEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const name of BUILD_ENV_ALLOWLIST) {
    const value = source[name];
    if (typeof value === "string") env[name] = value;
  }
  Object.assign(env, sandboxFixedEnv(args.scratchDir));
  for (const [name, value] of Object.entries(args.extraEnv ?? {})) {
    if (typeof value === "string") env[name] = value;
  }
  return env;
}

export interface SandboxedBuildResult {
  ok: boolean;
  /** Which tier actually executed the build — recorded so a run is auditable. */
  tier: BuildSandboxTier;
  stdout: string;
  stderr: string;
  /** Present when `!ok`. */
  error?: string;
  timedOut?: boolean;
  exitCode?: number | null;
}

function dockerBuildImage(): string | undefined {
  const image = process.env.BUILD_SANDBOX_IMAGE;
  return image && image.trim().length > 0 ? image.trim() : undefined;
}

let dockerProbe: boolean | undefined;
export function buildDockerDaemonAvailable(): boolean {
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

export function __resetBuildDockerProbeForTests(): void {
  dockerProbe = undefined;
}

/**
 * Argv for the docker tier. Pure and exported so the flags are assertable
 * without a daemon — see the caveat on `runSandboxedBuild`.
 */
export function dockerBuildInvocation(args: {
  image: string;
  siteRoot: string;
  containerName: string;
  command: string;
  commandArgs: string[];
  env: Record<string, string>;
  memoryMb: number;
  pidsLimit: number;
}): { command: string; commandArgs: string[] } {
  const envFlags: string[] = [];
  for (const [name, value] of Object.entries(args.env)) {
    // HOME/TMPDIR/npm_config_cache point at the host scratch dir, which is not
    // mounted into the container; inside, /scratch is the tmpfs equivalent.
    if (name === "HOME" || name === "TMPDIR" || name === "npm_config_cache") continue;
    envFlags.push("-e", `${name}=${value}`);
  }
  envFlags.push("-e", "HOME=/scratch", "-e", "TMPDIR=/scratch", "-e", "npm_config_cache=/scratch/npm-cache");

  return {
    command: "docker",
    commandArgs: [
      "run",
      "--rm",
      "--name",
      args.containerName,
      // Kernel-level: the container has no network interface at all, so no
      // amount of model-authored build code can reach the metadata server
      // (169.254.169.254) that hands out the runtime service account's token.
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/scratch:rw,nosuid,size=512m",
      // The site tree is the one writable mount — `next build` writes .next/.
      "--mount",
      `type=bind,src=${args.siteRoot},dst=/site`,
      "-w",
      "/site",
      "--user",
      "10001:10001",
      "--memory",
      `${args.memoryMb}m`,
      "--memory-swap",
      `${args.memoryMb}m`,
      "--pids-limit",
      String(args.pidsLimit),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      ...envFlags,
      args.image,
      args.command,
      ...args.commandArgs,
    ],
  };
}

/**
 * Runs one build of MODEL-AUTHORED code (SCRUM-317 / audit AU4).
 *
 * `LandingMakeAgent` is the engine's only file-writing agent; `landing.gate
 * --doBuild` then compiles and executes what it wrote (a Next.js build
 * evaluates `next.config.ts`, every module reachable from a page, and any
 * build script the site's own `package.json` declares). Before this function
 * existed that build was a bare `execFile("npm", ["run","build"])` with no
 * `env` option, which means it inherited the engine's entire environment —
 * every API key, the service-account path, and the proxy configuration.
 *
 * TWO TIERS, the same shape and for the same reason as `runCodeStep`'s:
 *
 *  1. `docker` — when BUILD_SANDBOX_IMAGE is set and a daemon answers. This
 *     is the tier that satisfies the ticket's "network-restricted" clause at
 *     the KERNEL level: `--network none` removes the interface, so the GCE
 *     metadata server that mints the runtime service account's access token
 *     is unreachable by construction. Non-root, caps dropped, root filesystem
 *     read-only except the site bind-mount and a tmpfs scratch.
 *
 *  2. `local` — the fallback (today's Cloud Run runner has no daemon). What
 *     it enforces is REAL but narrower, and it is worth being exact:
 *       credential-free env  → REAL. The child's environment is BUILT from
 *                              `BUILD_ENV_ALLOWLIST`, not filtered from
 *                              `process.env`, so no engine secret is present.
 *       no ambient ADC       → REAL. `HOME` is redirected to a throwaway
 *                              scratch dir, so gcloud's well-known
 *                              application-default-credentials file and
 *                              `~/.npmrc`'s auth tokens are not on any path
 *                              the build resolves.
 *       no egress config     → REAL. No proxy variable is forwarded, and
 *                              `npm_config_offline=true` makes the npm client
 *                              refuse the registry.
 *       no network egress    → NOT ENFORCED. A non-root process inside an
 *                              already-running container cannot take the
 *                              network away from its own child. If the build
 *                              host has direct egress, model-authored build
 *                              code can still open a socket — it just has no
 *                              credential to exfiltrate and no token endpoint
 *                              worth reaching, because the metadata server
 *                              answers to any local process regardless. That
 *                              last gap is precisely what the docker tier
 *                              closes, and why production should set
 *                              BUILD_SANDBOX_IMAGE.
 *
 * No shell in either tier: argv goes straight to the resolved binary, so the
 * `shell: true` class of injection stays fixed.
 */
export async function runSandboxedBuild(args: {
  command: string;
  commandArgs: string[];
  /** Absolute path to the directory to build in. Must already exist. */
  siteRoot: string;
  timeoutMs?: number | undefined;
  /** Variables deliberately granted to this build. Reviewable at the call site. */
  extraEnv?: Record<string, string | undefined> | undefined;
  memoryMb?: number | undefined;
  pidsLimit?: number | undefined;
}): Promise<SandboxedBuildResult> {
  const timeoutMs = Math.max(1, args.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS);
  const image = dockerBuildImage();
  const tier: BuildSandboxTier = image && buildDockerDaemonAvailable() ? "docker" : "local";

  const scratchDir = await mkdtemp(join(tmpdir(), "landing-build-"));
  try {
    const env = buildSandboxEnv({ scratchDir, extraEnv: args.extraEnv });
    let command = args.command;
    let commandArgs = args.commandArgs;
    let childEnv = env;
    let onTimeoutKill: (() => void) | undefined;

    if (tier === "docker") {
      const containerName = `karos-landing-build-${process.pid}-${Date.now().toString(36)}`;
      const invocation = dockerBuildInvocation({
        image: image as string,
        siteRoot: args.siteRoot,
        containerName,
        command: args.command,
        commandArgs: args.commandArgs,
        env,
        memoryMb: args.memoryMb ?? 2048,
        pidsLimit: args.pidsLimit ?? 512,
      });
      command = invocation.command;
      commandArgs = invocation.commandArgs;
      // The `docker` CLI itself needs PATH (and, on Windows, SystemRoot) to
      // run; it deliberately gets nothing else — the payload env is already
      // inside the argv above.
      childEnv = {};
      for (const name of ["PATH", "SystemRoot", "COMSPEC"]) {
        const value = process.env[name];
        if (typeof value === "string") childEnv[name] = value;
      }
      onTimeoutKill = () => {
        try {
          spawnSync("docker", ["kill", containerName], { stdio: "ignore", timeout: 10_000 });
        } catch {
          /* best effort */
        }
      };
    }

    const result = await execute({
      command,
      commandArgs,
      cwd: args.siteRoot,
      env: childEnv,
      timeoutMs,
      onTimeoutKill,
    });
    return { ...result, tier };
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function execute(args: {
  command: string;
  commandArgs: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  onTimeoutKill?: (() => void) | undefined;
}): Promise<Omit<SandboxedBuildResult, "tier">> {
  return await new Promise<Omit<SandboxedBuildResult, "tier">>((resolve) => {
    // No `shell: true`, and no shell wrapper: argv reaches the resolved binary
    // untouched, so nothing in the site tree can be read as shell syntax.
    const child = spawn(args.command, args.commandArgs, {
      cwd: args.cwd,
      env: args.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      args.onTimeoutKill?.();
      child.kill("SIGKILL");
    }, args.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, error: `Could not start the build: ${err.message}` });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, stdout, stderr, error: `Build timed out after ${args.timeoutMs}ms.`, timedOut: true, exitCode: code });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, stdout, stderr, error: `Build exited with code ${code}.`, exitCode: code });
        return;
      }
      resolve({ ok: true, stdout, stderr, exitCode: code });
    });
  });
}
