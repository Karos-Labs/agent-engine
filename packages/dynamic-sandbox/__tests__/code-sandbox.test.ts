import { describe, expect, it } from "vitest";
import { runCodeStep } from "../src/code-sandbox.js";

/**
 * The local tier imposes its rlimits through a POSIX shell wrapper
 * (`sh -c 'ulimit -v ... -f ...; exec python3 ...'`), and kills a runaway step
 * by signalling the process group. Neither exists on Windows: `ulimit` has no
 * equivalent, and killing the wrapper there leaves the interpreter running.
 *
 * The tests below that assert those specific kernel-level caps are therefore
 * skipped off POSIX rather than deleted or weakened — they are the tier's real
 * guarantees and they run in CI, which is Linux, as is Cloud Run. Every test
 * NOT marked this way runs everywhere, including all of the egress, write-fence
 * and secret-inheritance assertions, because those are enforced by the
 * interpreter guard rather than by the shell.
 */
const itPosix = process.platform === "win32" ? it.skip : it;

/**
 * Real subprocess tests (nothing about child_process is mocked) — this
 * module's whole job is actual OS-level and interpreter-level behaviour, so a
 * mock would test nothing that matters. python3 and node are both present in
 * the runner image for the same reason.
 *
 * These exercise the LOCAL tier, which is what runs when no Docker daemon is
 * reachable (today's Cloud Run runner, and this test environment). The docker
 * tier's flags are asserted separately in dynamic-code-sandbox-docker.test.ts,
 * which does not need a daemon to check the argv the sandbox builds.
 */

describe("runCodeStep — the contract, node", () => {
  it("round-trips: reads the JSON context from stdin, returns a JSON object on stdout", async () => {
    const result = await runCodeStep({
      language: "node",
      code: `
        let raw = "";
        process.stdin.on("data", (c) => (raw += c));
        process.stdin.on("end", () => {
          const ctx = JSON.parse(raw);
          console.log(JSON.stringify({ echoedCompany: ctx.inputs.company_name }));
        });
      `,
      context: { inputs: { company_name: "Acme" }, outputs: {} },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ echoedCompany: "Acme" });
    expect(result.tier).toBe("local");
  });

  it("fails cleanly on a non-zero exit code, surfacing stderr", async () => {
    const result = await runCodeStep({
      language: "node",
      code: `console.error("boom"); process.exit(1);`,
      context: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exited with code 1/);
    expect(result.stderr).toContain("boom");
  });

  it("fails cleanly when stdout is not valid JSON", async () => {
    const result = await runCodeStep({ language: "node", code: `console.log("not json");`, context: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not valid JSON/i);
  });

  it("fails cleanly when stdout is valid JSON but not an object (e.g. an array)", async () => {
    const result = await runCodeStep({ language: "node", code: `console.log(JSON.stringify([1, 2, 3]));`, context: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a JSON object/i);
  });

  it("kills the process and reports a timeout when it runs past its timeoutMs", async () => {
    const result = await runCodeStep({
      language: "node",
      code: `setTimeout(() => console.log(JSON.stringify({ok:true})), 5000);`,
      context: {},
      timeoutMs: 300,
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toMatch(/timed out/i);
  }, 15_000);

  it("kills the process and fails when stdout exceeds the size cap", async () => {
    const result = await runCodeStep({
      language: "node",
      // A single 6 MB write, well past MAX_STDOUT_BYTES (2 MB). Deliberately
      // NOT a `for(;;) process.stdout.write(...)` loop: that never yields to
      // the child's own event loop, so libuv cannot flush to the pipe and the
      // child deadlocks itself — a false negative unrelated to the cap.
      code: `process.stdout.write("x".repeat(6 * 1024 * 1024));`,
      context: {},
      timeoutMs: 10_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exceeded/i);
  }, 20_000);
});

describe("runCodeStep — the contract, python", () => {
  it("round-trips: reads the JSON context from stdin, returns a JSON object on stdout", async () => {
    const result = await runCodeStep({
      language: "python",
      code: `
import json, sys
ctx = json.load(sys.stdin)
print(json.dumps({"echoedCompany": ctx["inputs"]["company_name"]}))
`,
      context: { inputs: { company_name: "Acme" }, outputs: {} },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ echoedCompany: "Acme" });
  });

  it("fails cleanly on a non-zero exit code, surfacing stderr", async () => {
    const result = await runCodeStep({
      language: "python",
      code: `import sys\nsys.stderr.write("boom")\nsys.exit(1)\n`,
      context: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exited with code 1/);
    expect(result.stderr).toContain("boom");
  });

  it("fails cleanly when stdout is not valid JSON", async () => {
    const result = await runCodeStep({ language: "python", code: `print("not json")`, context: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not valid JSON/i);
  });

  itPosix("reports a timeout for a script that sleeps past its budget", async () => {
    const result = await runCodeStep({
      language: "python",
      code: `import time\ntime.sleep(30)\nprint("{}")\n`,
      context: {},
      timeoutMs: 400,
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  }, 15_000);
});

/* ──────────────────── the hard requirements, actually asserted ──────────────────── */

describe("hard requirement: no network egress (node)", () => {
  it("refuses require(\"net\") and its node: alias", async () => {
    for (const spec of [`require("net")`, `require("node:net")`]) {
      const result = await runCodeStep({
        language: "node",
        code: `try { ${spec}; console.log(JSON.stringify({escaped:true})); }
               catch (e) { console.error(e.message); process.exit(3); }`,
        context: {},
      });
      expect(result.ok, `${spec} should have been blocked`).toBe(false);
      expect(result.stderr).toMatch(/Blocked in the dynamic code sandbox/);
    }
  }, 20_000);

  it("refuses http, https, tls, dgram, dns and child_process", async () => {
    for (const mod of ["http", "https", "tls", "dgram", "dns", "child_process"]) {
      const result = await runCodeStep({
        language: "node",
        code: `try { require("${mod}"); console.log(JSON.stringify({escaped:true})); }
               catch (e) { console.error(e.message); process.exit(3); }`,
        context: {},
      });
      expect(result.ok, `${mod} should have been blocked`).toBe(false);
      expect(result.stderr).toMatch(/Blocked in the dynamic code sandbox/);
    }
  }, 40_000);

  it("neuters global fetch", async () => {
    const result = await runCodeStep({
      language: "node",
      code: `(async () => {
        try { await fetch("http://169.254.169.254/"); console.log(JSON.stringify({escaped:true})); }
        catch (e) { console.error(e.message); process.exit(3); }
      })();`,
      context: {},
    });
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/Blocked in the dynamic code sandbox/);
  }, 15_000);

  it("still allows the modules a data-transform step legitimately needs", async () => {
    const result = await runCodeStep({
      language: "node",
      code: `const os = require("node:os"); const path = require("node:path");
             console.log(JSON.stringify({ joined: path.join("a","b"), hasEol: typeof os.EOL === "string" }));`,
      context: {},
    });
    expect(result.ok).toBe(true);
    // Matched rather than compared literally: path.join uses the host's own
    // separator, and the claim under test is "the module is reachable and
    // works", not "the host is POSIX".
    const output = result.output as { joined: string; hasEol: boolean };
    expect(output.joined).toMatch(/^a[\\/]b$/);
    expect(output.hasEol).toBe(true);
  });
});

describe("hard requirement: no network egress (python)", () => {
  it("refuses socket, ssl, urllib, http, subprocess and ctypes", async () => {
    for (const mod of ["socket", "ssl", "urllib.request", "http.client", "subprocess", "ctypes"]) {
      const result = await runCodeStep({
        language: "python",
        code: `import sys\ntry:\n    import ${mod}\n    print('{"escaped":true}')\nexcept BaseException as e:\n    sys.stderr.write(str(e))\n    sys.exit(3)\n`,
        context: {},
      });
      expect(result.ok, `${mod} should have been blocked`).toBe(false);
      expect(result.stderr).toMatch(/Blocked in the dynamic code sandbox/);
    }
  }, 40_000);

  it("still allows json, math, re and datetime", async () => {
    const result = await runCodeStep({
      language: "python",
      code: `import json, math, re, datetime\nprint(json.dumps({"ok": True, "sqrt": math.sqrt(9), "found": bool(re.match("a","abc"))}))\n`,
      context: {},
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ ok: true, sqrt: 3, found: true });
  });
});

describe("hard requirement: writes confined to the scratch dir", () => {
  it("node may write inside its scratch dir", async () => {
    const result = await runCodeStep({
      language: "node",
      code: `const fs = require("node:fs");
             const p = process.env.KAROS_SANDBOX_SCRATCH + "/out.txt";
             fs.writeFileSync(p, "hello");
             console.log(JSON.stringify({ wrote: fs.readFileSync(p, "utf8") }));`,
      context: {},
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ wrote: "hello" });
  });

  it("node may NOT write outside it", async () => {
    for (const target of ["/tmp/karos-escape-test.txt", "../escape.txt", "/etc/x"]) {
      const result = await runCodeStep({
        language: "node",
        code: `const fs = require("node:fs");
               try { fs.writeFileSync(${JSON.stringify(target)}, "x"); console.log(JSON.stringify({escaped:true})); }
               catch (e) { console.error(e.message); process.exit(3); }`,
        context: {},
      });
      expect(result.ok, `${target} should have been blocked`).toBe(false);
      expect(result.stderr).toMatch(/Blocked in the dynamic code sandbox/);
    }
  }, 30_000);

  it("node's fs.promises and createWriteStream are guarded too", async () => {
    const viaPromises = await runCodeStep({
      language: "node",
      code: `require("node:fs").promises.writeFile("/tmp/karos-escape-p.txt","x")
               .then(() => console.log(JSON.stringify({escaped:true})))
               .catch((e) => { console.error(e.message); process.exit(3); });`,
      context: {},
    });
    expect(viaPromises.ok).toBe(false);
    expect(viaPromises.stderr).toMatch(/Blocked in the dynamic code sandbox/);

    const viaStream = await runCodeStep({
      language: "node",
      code: `try { require("node:fs").createWriteStream("/tmp/karos-escape-s.txt"); console.log(JSON.stringify({escaped:true})); }
             catch (e) { console.error(e.message); process.exit(3); }`,
      context: {},
    });
    expect(viaStream.ok).toBe(false);
    expect(viaStream.stderr).toMatch(/Blocked in the dynamic code sandbox/);
  }, 20_000);

  it("python may write inside its scratch dir but not outside", async () => {
    const inside = await runCodeStep({
      language: "python",
      code: `import json, os\np = os.path.join(os.environ["KAROS_SANDBOX_SCRATCH"], "out.txt")\nopen(p,"w").write("hello")\nprint(json.dumps({"wrote": open(p).read()}))\n`,
      context: {},
    });
    expect(inside.ok).toBe(true);
    expect(inside.output).toEqual({ wrote: "hello" });

    const outside = await runCodeStep({
      language: "python",
      code: `import sys\ntry:\n    open("/tmp/karos-escape-py.txt","w").write("x")\n    print('{"escaped":true}')\nexcept BaseException as e:\n    sys.stderr.write(str(e))\n    sys.exit(3)\n`,
      context: {},
    });
    expect(outside.ok).toBe(false);
    expect(outside.stderr).toMatch(/Blocked in the dynamic code sandbox/);
  }, 20_000);

  it("reading outside the scratch dir is still allowed — only writes are fenced", async () => {
    const result = await runCodeStep({
      language: "node",
      // process.execPath is the running interpreter's own binary: outside the
      // scratch dir on every platform, and guaranteed to exist.
      code: `const fs = require("node:fs");
             console.log(JSON.stringify({ canRead: fs.existsSync(process.execPath) }));`,
      context: {},
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ canRead: true });
  });
});

describe("hard requirement: the step never inherits the runner's secrets", () => {
  it("gives the child none of this process's environment beyond PATH/LANG and its own scratch pointers", async () => {
    const prior = process.env.SCRAPPYCOCO_API_KEY;
    process.env.SCRAPPYCOCO_API_KEY = "sc-must-not-leak";
    process.env.SOME_SECRET_FOR_TEST = "must-not-leak";
    try {
      const result = await runCodeStep({
        language: "node",
        code: `console.log(JSON.stringify({
                 key: process.env.SCRAPPYCOCO_API_KEY ?? null,
                 other: process.env.SOME_SECRET_FOR_TEST ?? null,
                 proxy: process.env.HTTPS_PROXY ?? null,
                 scratch: typeof process.env.KAROS_SANDBOX_SCRATCH === "string",
               }));`,
        context: {},
      });
      expect(result.ok).toBe(true);
      expect(result.output).toEqual({ key: null, other: null, proxy: null, scratch: true });
    } finally {
      if (prior === undefined) delete process.env.SCRAPPYCOCO_API_KEY;
      else process.env.SCRAPPYCOCO_API_KEY = prior;
      delete process.env.SOME_SECRET_FOR_TEST;
    }
  });
});

describe("hard requirement: memory and file-size caps", () => {
  itPosix("python is stopped by the address-space cap rather than eating the container", async () => {
    const result = await runCodeStep({
      language: "python",
      // Well past MAX_MEMORY_MB (512): a 2 GB allocation must fail, not swap
      // the job's own AI steps out of memory.
      code: `import sys\ntry:\n    b = bytearray(2 * 1024 * 1024 * 1024)\n    print('{"escaped":true}')\nexcept BaseException as e:\n    sys.stderr.write(type(e).__name__)\n    sys.exit(3)\n`,
      context: {},
      timeoutMs: 20_000,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toBeUndefined();
  }, 30_000);

  itPosix("the file-size rlimit stops a step writing an unbounded file into its scratch dir", async () => {
    const result = await runCodeStep({
      language: "python",
      // 10 MB cap (ulimit -f 20480 blocks); 40 MB must not succeed.
      code: `import os, sys\np = os.path.join(os.environ["KAROS_SANDBOX_SCRATCH"], "big.bin")\ntry:\n    with open(p, "w") as fh:\n        fh.write("x" * (40 * 1024 * 1024))\n    print('{"escaped":true}')\nexcept BaseException as e:\n    sys.stderr.write(type(e).__name__)\n    sys.exit(3)\n`,
      context: {},
      timeoutMs: 20_000,
    });
    expect(result.ok).toBe(false);
  }, 30_000);
});
