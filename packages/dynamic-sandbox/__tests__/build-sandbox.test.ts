import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BUILD_ENV_ALLOWLIST, buildSandboxEnv, dockerBuildInvocation, runSandboxedBuild } from "../src/build-sandbox.js";

/**
 * SCRUM-317 / audit AU4: the build sandbox `landing.gate --doBuild` runs
 * model-authored code inside.
 *
 * These tests are written to make the guard FAIL in both directions — an
 * allowlist that quietly passes everything through and an allowlist that
 * drops everything are both "checks structurally incapable of failing", and
 * each is asserted against below.
 */
describe("BUILD_ENV_ALLOWLIST", () => {
  it("is non-empty and contains no credential-shaped name", () => {
    expect(BUILD_ENV_ALLOWLIST.length).toBeGreaterThan(0);
    for (const name of BUILD_ENV_ALLOWLIST) {
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PROXY/i);
    }
  });
});

describe("buildSandboxEnv", () => {
  const scratch = "/tmp/scratch-fixture";

  it("drops every variable that is not on the allowlist", () => {
    const sandboxed = buildSandboxEnv({
      scratchDir: scratch,
      sourceEnv: {
        ANTHROPIC_API_KEY: "sk-ant-leak",
        GOOGLE_APPLICATION_CREDENTIALS: "/var/secrets/adc.json",
        FIREBASE_SERVICE_ACCOUNT_KEY: "{}",
        HTTPS_PROXY: "http://egress:3128",
        https_proxy: "http://egress:3128",
        NODE_OPTIONS: "--require /app/packages/core/dist/index.js",
        PATH: "/usr/bin",
      },
    });
    expect(sandboxed.ANTHROPIC_API_KEY).toBeUndefined();
    expect(sandboxed.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(sandboxed.FIREBASE_SERVICE_ACCOUNT_KEY).toBeUndefined();
    expect(sandboxed.HTTPS_PROXY).toBeUndefined();
    expect(sandboxed.https_proxy).toBeUndefined();
    expect(sandboxed.NODE_OPTIONS).toBeUndefined();
  });

  /**
   * The other direction. An allowlist that filtered EVERYTHING out would pass
   * the test above and be just as broken — `npm` would not resolve at all.
   */
  it("keeps the variables that are on the allowlist", () => {
    const sandboxed = buildSandboxEnv({
      scratchDir: scratch,
      sourceEnv: { PATH: "/usr/local/bin:/usr/bin", LANG: "en_US.UTF-8", NODE_ENV: "production" },
    });
    expect(sandboxed.PATH).toBe("/usr/local/bin:/usr/bin");
    expect(sandboxed.LANG).toBe("en_US.UTF-8");
    expect(sandboxed.NODE_ENV).toBe("production");
  });

  it("matches whole names only — an npm_config_ prefix rule would leak the registry auth token", () => {
    const sandboxed = buildSandboxEnv({
      scratchDir: scratch,
      sourceEnv: { "npm_config_//registry.npmjs.org/:_authToken": "npm-leak", npm_config_registry: "https://evil.example" },
    });
    expect(sandboxed["npm_config_//registry.npmjs.org/:_authToken"]).toBeUndefined();
    expect(sandboxed.npm_config_registry).toBeUndefined();
  });

  it("redirects HOME and TMPDIR to the scratch dir even when the parent has its own", () => {
    const sandboxed = buildSandboxEnv({ scratchDir: scratch, sourceEnv: { HOME: "/home/node", TMPDIR: "/tmp" } });
    expect(sandboxed.HOME).toBe(scratch);
    expect(sandboxed.TMPDIR).toBe(scratch);
  });

  it("turns the npm client's own registry access off", () => {
    const sandboxed = buildSandboxEnv({ scratchDir: scratch, sourceEnv: {} });
    expect(sandboxed.npm_config_offline).toBe("true");
    expect(sandboxed.npm_config_cache).toBe(path.join(scratch, "npm-cache"));
  });

  it("grants only what the call site names in extraEnv", () => {
    const sandboxed = buildSandboxEnv({
      scratchDir: scratch,
      sourceEnv: { ANTHROPIC_API_KEY: "sk-ant-leak", SOME_BUILD_FLAG: "from-parent" },
      extraEnv: { SOME_BUILD_FLAG: "granted", UNSET_ONE: undefined },
    });
    expect(sandboxed.SOME_BUILD_FLAG).toBe("granted");
    expect(sandboxed.UNSET_ONE).toBeUndefined();
    expect(sandboxed.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("dockerBuildInvocation", () => {
  // NOTE: this asserts the ARGV only. No Docker daemon runs in CI or in this
  // test environment, so the kernel-level behaviour of these flags is NOT
  // demonstrated here — see the report. The argv is still worth pinning: a
  // dropped `--network none` is the exact silent regression this file exists
  // to catch.
  const invocation = dockerBuildInvocation({
    image: "gcr.io/karoscmo/landing-build:1",
    siteRoot: "/clients/forge/site",
    containerName: "karos-landing-build-test",
    command: "npm",
    commandArgs: ["run", "build"],
    env: { PATH: "/usr/bin", HOME: "/host/scratch", ANTHROPIC_API_KEY: "should-never-be-here" },
    memoryMb: 2048,
    pidsLimit: 512,
  });

  it("removes the network interface entirely", () => {
    const i = invocation.commandArgs.indexOf("--network");
    expect(i).toBeGreaterThan(-1);
    expect(invocation.commandArgs[i + 1]).toBe("none");
  });

  it("runs non-root with no capabilities and a read-only root filesystem", () => {
    expect(invocation.commandArgs).toContain("--read-only");
    expect(invocation.commandArgs).toContain("--user");
    expect(invocation.commandArgs).toContain("10001:10001");
    expect(invocation.commandArgs).toContain("--cap-drop");
    expect(invocation.commandArgs).toContain("ALL");
    expect(invocation.commandArgs).toContain("no-new-privileges");
  });

  it("rewrites HOME to the container tmpfs rather than the host scratch path", () => {
    expect(invocation.commandArgs).toContain("HOME=/scratch");
    expect(invocation.commandArgs).not.toContain("HOME=/host/scratch");
  });

  it("passes through whatever env the caller built — the allowlist is the filter, not this function", () => {
    // Guards against someone later "hardening" here instead of in buildSandboxEnv
    // and leaving the local tier open. buildSandboxEnv is the single choke point.
    expect(invocation.commandArgs).toContain("ANTHROPIC_API_KEY=should-never-be-here");
  });
});

describe("runSandboxedBuild (local tier)", () => {
  // The planted name is built at runtime, never written as a dotted env-var
  // literal, on purpose: scripts/config-inventory.ts scans __tests__ too, and a
  // literal here would be reported as an undocumented credential the app reads.
  const PLANTED_NAME = "KAROS_BUILD_SANDBOX_UNIT_PROBE";

  it("runs the command in siteRoot with the sandboxed environment and reports success", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "build-sandbox-"));
    try {
      const saved = process.env[PLANTED_NAME];
      process.env[PLANTED_NAME] = "leak-me";
      const probe = `process.stdout.write(JSON.stringify({secret:process.env[${JSON.stringify(PLANTED_NAME)}]??null,home:process.env.HOME,cwd:process.cwd()}))`;
      const outcome = await runSandboxedBuild({
        command: process.execPath,
        commandArgs: ["-e", probe],
        siteRoot: tmp,
        timeoutMs: 30_000,
      });
      if (saved === undefined) delete process.env[PLANTED_NAME];
      else process.env[PLANTED_NAME] = saved;

      expect(outcome.ok).toBe(true);
      expect(outcome.tier).toBe("local");
      const seen = JSON.parse(outcome.stdout) as { secret: string | null; home: string; cwd: string };
      expect(seen.secret).toBeNull();
      expect(seen.home).not.toBe(process.env.HOME);
      expect(await fs.realpath(seen.cwd)).toBe(await fs.realpath(tmp));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("reports a non-zero exit as a failure with the child's own diagnostic", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "build-sandbox-"));
    try {
      const outcome = await runSandboxedBuild({
        command: process.execPath,
        commandArgs: ["-e", "process.stderr.write('Type error in page.tsx'); process.exit(1)"],
        siteRoot: tmp,
        timeoutMs: 30_000,
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.stderr).toContain("Type error in page.tsx");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("kills a build that overruns its wall clock", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "build-sandbox-"));
    try {
      const outcome = await runSandboxedBuild({
        command: process.execPath,
        commandArgs: ["-e", "setTimeout(()=>{},60000)"],
        siteRoot: tmp,
        timeoutMs: 300,
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.timedOut).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
