import { describe, expect, it } from "vitest";
import { dockerInvocation, localInvocation } from "../src/code-sandbox.js";

/**
 * The docker tier is where Phase 7's hard requirements are met by the KERNEL
 * rather than by an interpreter guard, so what matters is that the exact flags
 * are on the command line. Asserting the argv needs no daemon, which is why
 * this suite runs everywhere instead of being skipped in CI — a dropped
 * `--network none` would otherwise only be caught in an environment that
 * happens to have Docker.
 */

function invocation(language: "python" | "node" = "node", timeoutMs = 30_000) {
  return dockerInvocation({
    image: "karos/code-sandbox:test",
    language,
    scriptName: language === "python" ? "step.py" : "step.js",
    guardName: language === "python" ? "__karos_guard.py" : "__karos_guard.cjs",
    timeoutMs,
    codeB64: Buffer.from("print(1)").toString("base64"),
    guardB64: Buffer.from("# guard").toString("base64"),
  });
}

/** The value that follows a flag, e.g. flagValue(argv, "--memory") -> "512m". */
function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

describe("docker tier — the hard requirements are on the command line", () => {
  it("gives the container no network interface at all", () => {
    expect(flagValue(invocation().commandArgs, "--network")).toBe("none");
  });

  it("mounts the root filesystem read-only, with a size-capped noexec tmpfs as the only writable path", () => {
    const argv = invocation().commandArgs;
    expect(argv).toContain("--read-only");
    const tmpfs = flagValue(argv, "--tmpfs");
    expect(tmpfs).toBeDefined();
    expect(tmpfs).toContain("/scratch");
    expect(tmpfs).toContain("rw");
    expect(tmpfs).toContain("noexec");
    expect(tmpfs).toContain("nosuid");
    expect(tmpfs).toMatch(/size=\d+m/);
  });

  it("runs as a non-root uid with every capability dropped and no privilege escalation", () => {
    const argv = invocation().commandArgs;
    expect(flagValue(argv, "--user")).toBe("10001:10001");
    expect(flagValue(argv, "--cap-drop")).toBe("ALL");
    expect(flagValue(argv, "--security-opt")).toBe("no-new-privileges");
  });

  it("caps memory with swap pinned to the same value, so the cap cannot be paged around", () => {
    const argv = invocation().commandArgs;
    expect(flagValue(argv, "--memory")).toBe("512m");
    expect(flagValue(argv, "--memory-swap")).toBe("512m");
  });

  it("caps process count against a fork bomb", () => {
    expect(Number(flagValue(invocation().commandArgs, "--pids-limit"))).toBeGreaterThan(0);
  });

  it("removes the container on exit and keeps stdin open for the context", () => {
    const argv = invocation().commandArgs;
    expect(argv).toContain("--rm");
    expect(argv).toContain("-i");
  });

  it("points HOME/TMPDIR and the guard's scratch variable at the tmpfs, and forwards nothing else", () => {
    const argv = invocation().commandArgs;
    const envFlags = argv.reduce<string[]>((acc, a, i) => (a === "-e" ? [...acc, String(argv[i + 1])] : acc), []);
    expect(envFlags).toEqual(
      expect.arrayContaining(["KAROS_SANDBOX_SCRATCH=/scratch", "HOME=/scratch", "TMPDIR=/scratch"]),
    );
    // No Anthropic key, no proxy, no runner token — the allowlist is the whole list.
    expect(envFlags.join(" ")).not.toMatch(/ANTHROPIC|PROXY|JOB_SPEC/i);
  });

  it("carries the author's code and the guard as base64 argv, never as an env var", () => {
    const inv = invocation();
    const argv = inv.commandArgs;
    expect(argv[argv.length - 2]).toBe(Buffer.from("print(1)").toString("base64"));
    expect(argv[argv.length - 1]).toBe(Buffer.from("# guard").toString("base64"));
    const bootstrap = argv[argv.indexOf("-c") + 1] ?? "";
    expect(bootstrap).toContain("base64 -d > /scratch/step.js");
    expect(bootstrap).toContain("--require /scratch/__karos_guard.cjs");
  });

  it("derives the CPU-seconds rlimit from the step's own timeout", () => {
    const bootstrap = (argv: string[]) => argv[argv.indexOf("-c") + 1] ?? "";
    expect(bootstrap(invocation("node", 5_000).commandArgs)).toContain("ulimit -t 5");
    expect(bootstrap(invocation("node", 45_000).commandArgs)).toContain("ulimit -t 45");
  });

  it("uses python3 + the guard for a python step, and node + --require for a node step", () => {
    const py = invocation("python").commandArgs;
    expect(py[py.indexOf("-c") + 1]).toContain("exec python3 /scratch/__karos_guard.py /scratch/step.py");
    const node = invocation("node").commandArgs;
    expect(node[node.indexOf("-c") + 1]).toContain("exec node --max-old-space-size=512 --require");
  });

  it("names the container so a timed-out step can be killed rather than orphaned", () => {
    const inv = invocation();
    expect(flagValue(inv.commandArgs, "--name")).toMatch(/^karos-code-step-/);
    expect(typeof inv.onTimeoutKill).toBe("function");
  });
});

describe("local tier — the rlimits a non-root process actually can impose", () => {
  function localScript(language: "python" | "node", timeoutMs = 30_000): string {
    const inv = localInvocation({
      language,
      scratchDir: "/tmp/scratch-x",
      scriptName: language === "python" ? "step.py" : "step.js",
      guardName: language === "python" ? "__karos_guard.py" : "__karos_guard.cjs",
      timeoutMs,
    });
    expect(inv.command).toBe("sh");
    return inv.commandArgs[1] ?? "";
  }

  it("caps file size and CPU seconds for both languages", () => {
    for (const language of ["python", "node"] as const) {
      const script = localScript(language);
      expect(script).toContain("ulimit -f 20480");
      expect(script).toContain("ulimit -t 30");
    }
  });

  it("applies ulimit -v to python only — V8 aborts at startup under RLIMIT_AS", () => {
    expect(localScript("python")).toContain("ulimit -v 524288");
    expect(localScript("node")).not.toContain("ulimit -v");
    expect(localScript("node")).toContain("--max-old-space-size=512");
  });

  it("loads the guard before the author's script in both languages", () => {
    expect(localScript("node")).toContain('--require "$1" "$2"');
    expect(localScript("python")).toContain('exec python3 "$1" "$2"');
  });

  it("hands the child only PATH/LANG plus its own scratch pointers", () => {
    const inv = localInvocation({
      language: "node",
      scratchDir: "/tmp/scratch-x",
      scriptName: "step.js",
      guardName: "__karos_guard.cjs",
      timeoutMs: 1_000,
    });
    expect(inv.env.KAROS_SANDBOX_SCRATCH).toBe("/tmp/scratch-x");
    expect(inv.env.HOME).toBe("/tmp/scratch-x");
    expect(inv.env.TMPDIR).toBe("/tmp/scratch-x");
    expect(Object.keys(inv.env).sort()).toEqual(
      expect.arrayContaining(["HOME", "KAROS_SANDBOX_SCRATCH", "TMPDIR"]),
    );
    for (const forbidden of ["ANTHROPIC_API_KEY", "HTTPS_PROXY", "JOB_SPEC_B64", "JOB_SPEC_REF_B64", "SCRAPPYCOCO_API_KEY"]) {
      expect(inv.env[forbidden]).toBeUndefined();
    }
  });
});
