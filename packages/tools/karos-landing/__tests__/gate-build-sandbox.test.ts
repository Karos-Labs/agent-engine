import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createLandingGate } from "../src/gate/gate-tool.js";
import { BrandJsonSchema } from "../src/types.js";
import { testCtx } from "./test-helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, "fixtures", "forge");

/**
 * SCRUM-317 / AU4. `landing.gate --doBuild` executes MODEL-AUTHORED code:
 * `LandingMakeAgent` is the only file-writing agent in the engine, and the
 * files it writes are what `npm run build` then compiles and runs (a Next.js
 * build evaluates `next.config.ts`, every `page.tsx`, and any postinstall-ish
 * build hook in the site's own package.json). Those are model outputs.
 *
 * The requirement in the ticket is structural: that build must not run with
 * the engine's ambient credentials, and must not inherit the egress
 * configuration that is the process's route off-box.
 *
 * This test spies on the build child's real environment by putting a fake
 * `npm` first on PATH that dumps `env` into the site directory, then asserts
 * on what actually reached it — not on what the gate says it passed.
 */
describe("SCRUM-317: landing.gate's build runs credential-free", () => {
  let tmpRoot: string;
  let engineClientsRoot: string;
  let siteRoot: string;
  let brand: unknown;
  const savedEnv: Record<string, string | undefined> = {};

  const PLANTED = {
    ANTHROPIC_API_KEY: "sk-ant-PLANTED-anthropic",
    GOOGLE_APPLICATION_CREDENTIALS: "/var/secrets/PLANTED-adc.json",
    FIREBASE_SERVICE_ACCOUNT_KEY: "{\"private_key\":\"PLANTED-firebase\"}",
    PUBSUB_PUSH_TOKEN: "PLANTED-pubsub-token",
    HTTPS_PROXY: "http://PLANTED-egress-proxy:3128",
  };

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "landing-gate-sandbox-"));
    engineClientsRoot = path.join(tmpRoot, "clients");
    siteRoot = path.join(engineClientsRoot, "forge", "site");
    await fs.mkdir(siteRoot, { recursive: true });
    await fs.cp(path.join(FIXTURE_ROOT, "site"), siteRoot, { recursive: true });
    brand = JSON.parse(await fs.readFile(path.join(FIXTURE_ROOT, "brand.json"), "utf8"));

    // A fake `npm` that records the environment its parent handed it.
    const fakeBin = path.join(tmpRoot, "bin");
    await fs.mkdir(fakeBin, { recursive: true });
    const dumpPath = path.join(tmpRoot, "build-env-dump.txt");
    await fs.writeFile(
      path.join(fakeBin, "npm"),
      `#!/bin/sh\nenv > ${JSON.stringify(dumpPath)}\nexit 0\n`,
      { mode: 0o755 },
    );

    for (const [k, v] of Object.entries({ ...PLANTED, PATH: `${fakeBin}:${process.env.PATH ?? ""}` })) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function runBuild(): Promise<Map<string, string>> {
    const tool = createLandingGate({
      templateRoot: path.join(tmpRoot, "template"),
      engineClientsRoot,
      bundlesRoot: path.join(tmpRoot, "bundles"),
    });
    const outcome = await tool.execute(
      { brand: BrandJsonSchema.parse(brand), doBuild: true },
      { ctx: testCtx({ clientSlug: "forge" }) },
    );
    expect(outcome.status).toBe("success");
    // Clause 7: prove the intervention ran at all before reading its result.
    const dump = await fs.readFile(path.join(tmpRoot, "build-env-dump.txt"), "utf8");
    const env = new Map<string, string>();
    for (const line of dump.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) env.set(line.slice(0, eq), line.slice(eq + 1));
    }
    expect(env.size).toBeGreaterThan(0);
    return env;
  }

  it("hands the build no ambient credential from the engine's environment", async () => {
    const buildEnv = await runBuild();
    for (const name of Object.keys(PLANTED)) {
      expect({ name, value: buildEnv.get(name) }).toEqual({ name, value: undefined });
    }
  });

  it("does not hand the build the process's egress (proxy) configuration", async () => {
    const buildEnv = await runBuild();
    expect(buildEnv.get("HTTPS_PROXY")).toBeUndefined();
    expect(buildEnv.get("https_proxy")).toBeUndefined();
  });

  it("redirects HOME away from the engine user's home, so well-known credential files are out of reach", async () => {
    const buildEnv = await runBuild();
    const home = buildEnv.get("HOME");
    expect(home).toBeDefined();
    expect(home).not.toBe(process.env.HOME);
  });
});
