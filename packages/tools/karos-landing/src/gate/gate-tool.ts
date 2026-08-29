import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";
import { runSandboxedBuild } from "@agent-engine/dynamic-sandbox";
import type { LandingEngineConfig } from "../config.js";
import { siteRootForClient } from "../sandbox/site-sandbox.js";
import { BrandJsonSchema, type BrandJson } from "../types.js";
import { GENERATED_CARRY_FORWARD_PLACEMENT_RELATIVE_PATH, GENERATED_CONTENT_RELATIVE_PATH, CarryForwardPlacementFileSchema } from "../generated-paths.js";
import { collectFiles } from "./shared.js";
import { checkTokenDrift } from "./token-drift.js";
import { checkFontFidelity } from "./font-fidelity.js";
import { checkBrandLint } from "./brand-lint.js";
import { checkStructure } from "./structure.js";
import { checkCarryForward, readFileContents } from "./carry-forward.js";
import type { GateViolation } from "./shared.js";
import * as path from "node:path";

const TOOL_VERSION = "1.1.0";
const BUILD_TIMEOUT_MS = 300_000;
// Resolved explicitly (never via `shell: true`) so a client-influenced value reaching this
// call — the working directory is a build product of client/scraped content — can never be
// interpreted by a shell; `npm.cmd` is npm's real executable name on Windows (`npm` alone is
// a shell shim there and is not directly spawnable by execFile without a shell).
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";

export const LandingGateInputSchema = z.object({
  brand: BrandJsonSchema.describe("This client's brand.json contract — checked against the built site's globals.css, fonts, and content for token drift, font fidelity, brand lint, and carry-forward completeness."),
  doBuild: z
    .boolean()
    .default(false)
    .describe("Mirrors gate.mjs --build: runs npm run build in the site directory. Off by default — slow, and out of scope for most calls (e.g. a mid-MAKE check)."),
});
export type LandingGateInput = z.infer<typeof LandingGateInputSchema>;

export interface LandingGateChecks {
  tokenDrift: { colors: number; missing: number };
  fontFidelity: string[] | "none";
  brandLint: { forbidEmDash: boolean; forbidEnDash: boolean; forbidExcl: boolean };
  structure: { fileCount: number; componentCount: number };
  carryForward: { total: number; missing: string[] };
  build: "skipped" | "pass" | "fail";
}

export type LandingGateVerdict =
  | { verdict: "pass"; evidence: string[]; toolVersion: string; checks: LandingGateChecks }
  | {
      verdict: "content_fail";
      evidence: string[];
      reason: string;
      toolVersion: string;
      checks: LandingGateChecks;
      hardViolations: GateViolation[];
      warnings: GateViolation[];
    }
  | { verdict: "tooling_error"; reason: string; toolVersion: string };

async function readTextIfExists(absolutePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(absolutePath, "utf8");
  } catch {
    return undefined;
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function summarizeEvidence(checks: LandingGateChecks): string[] {
  return [
    `token drift: ${checks.tokenDrift.colors - checks.tokenDrift.missing}/${checks.tokenDrift.colors} brand colors found in globals.css`,
    `font fidelity: ${checks.fontFidelity === "none" ? "no fonts declared" : checks.fontFidelity.join(", ")}`,
    `structure: ${checks.structure.componentCount} component(s) scanned`,
    `carry-forward: ${checks.carryForward.total - checks.carryForward.missing.length}/${checks.carryForward.total} present`,
    `build: ${checks.build}`,
  ];
}

/**
 * `landing.gate` (RFC-07 §7 / task spec Layer 1): a TypeScript port of
 * `engine/gate.mjs`'s objective floor — token drift, font fidelity, brand
 * lint, structure — plus the strict `carryForward[]` completeness check
 * ENGINE-SPEC §3 requires and the original script deliberately left to a
 * later phase. Reads the *already-built* site directly off disk (never
 * accepts a site path as an argument — `ctx.clientSlug` is the only
 * coordinate, same rule every other tool in this package follows) and never
 * writes anything; this is a read-only verifier. Returns a `GateVerdict`-
 * shaped result (a strict superset, same convention as `gate.brandCompliance`)
 * so `BaseAgent`'s `selfCritique` self-critique loop (RFC-01 §5.6) can drive
 * revisions directly off it if a craft/coding agent step is ever wired
 * through `selfCritique` instead of the workflow's own gate-then-fix step.
 *
 * The render checks (dev-server 200, no horizontal overflow, no near-black
 * opener, console clean @390+@1280) and the craft verdict are deliberately
 * NOT here — `gate.mjs`'s own header comment says they need a browser
 * (`landing.renderCheck`) or a judgment call (a bounded `BaseAgent`), neither
 * of which belongs in a dependency-light deterministic tool.
 */
export function createLandingGate(config: LandingEngineConfig) {
  return defineTool<LandingGateInput, LandingGateVerdict>({
    name: "landing.gate",
    description:
      "A TypeScript port of engine/gate.mjs's objective floor for a built landing site: token drift, font fidelity, brand lint, structure, and carry-forward completeness, plus an optional sandboxed `npm run build`. Read-only — reads the already-built site off disk for this client and never writes anything.",
    version: TOOL_VERSION,
    inputSchema: LandingGateInputSchema,
    async execute({ brand, doBuild }, { ctx }) {
      const siteRoot = siteRootForClient(config, ctx.clientSlug);

      let siteExists = true;
      try {
        await fs.access(siteRoot);
      } catch {
        siteExists = false;
      }
      if (!siteExists) {
        return toolingError(`no built site found at "${siteRoot}" — run landing.copyTemplate (and the MAKE phase) before gating`);
      }

      const files = await collectFiles(siteRoot);
      const cssFiles = files.filter((f) => /\.css$/.test(f));
      const globalsCssParts = await Promise.all(cssFiles.map((f) => fs.readFile(f, "utf8")));
      const globalsCss = globalsCssParts.join("\n");

      const brandTyped: BrandJson = brand;
      const tokenDrift = checkTokenDrift(brandTyped.tokens, globalsCss, siteRoot);
      const fontFidelity = checkFontFidelity(brandTyped.fonts, globalsCss, siteRoot);

      const contentFiles = files.filter((f) => /(content|components)\b/.test(f) && /\.tsx?$/.test(f));
      const brandLint = await checkBrandLint(brandTyped, contentFiles, siteRoot);

      const componentFiles = files.filter((f) => /components[/\\].+\.tsx$/.test(f));
      const structure = await checkStructure(componentFiles, siteRoot);

      const contentSource = await readTextIfExists(path.join(siteRoot, GENERATED_CONTENT_RELATIVE_PATH));
      const placementsRaw = await readTextIfExists(path.join(siteRoot, GENERATED_CARRY_FORWARD_PLACEMENT_RELATIVE_PATH));
      const placementsParsed = placementsRaw ? CarryForwardPlacementFileSchema.safeParse(safeJsonParse(placementsRaw)) : undefined;
      const placements = placementsParsed?.success ? placementsParsed.data : undefined;
      const pageTsxSource = await readTextIfExists(path.join(siteRoot, "src", "app", "page.tsx"));
      // Only consulted as a legacy-fixture fallback (see carry-forward.ts's header comment) —
      // never needed for output this pipeline itself produced, which always writes a placement file.
      const allSiteContents = placements ? undefined : await readFileContents(files);
      const allSiteText = allSiteContents ? [...allSiteContents.values()].join("\n") : undefined;
      const carryForward = checkCarryForward(brandTyped.carryForward ?? [], placements, contentSource, pageTsxSource, allSiteText, siteRoot);

      let build: "skipped" | "pass" | "fail" = "skipped";
      const buildViolations: GateViolation[] = [];
      if (doBuild) {
        // SCRUM-317 / audit AU4. This line compiles and executes MODEL-AUTHORED code:
        // `LandingMakeAgent` is the engine's only file-writing agent, and a Next.js build
        // evaluates `next.config.ts`, every module a page reaches, and whatever build script
        // the site's own package.json declares. It used to run with `execFile`'s default
        // `env` — i.e. the engine's ENTIRE environment: ANTHROPIC_API_KEY,
        // GOOGLE_APPLICATION_CREDENTIALS, the Firebase key, the proxy configuration. The
        // `shell: true` hole was closed earlier; this is the credential hole behind it.
        //
        // `runSandboxedBuild` builds the child's environment from an explicit allowlist
        // (@agent-engine/dynamic-sandbox's BUILD_ENV_ALLOWLIST) rather than inheriting or
        // filtering, redirects HOME/TMPDIR to a throwaway scratch dir so `~`-anchored
        // credential files (gcloud ADC, ~/.npmrc) are off the resolution path, and forwards
        // no egress configuration. With BUILD_SANDBOX_IMAGE set it runs the same argv in a
        // `--network none`, read-only, non-root container instead, which is the tier that
        // makes "no ambient service-account access" true at the kernel level — the metadata
        // server has no interface to answer on.
        //
        // No credential is granted here. If a build ever legitimately needs one, it is named
        // in `extraEnv` at this call site, where a reviewer sees it.
        const outcome = await runSandboxedBuild({
          command: NPM_COMMAND,
          commandArgs: ["run", "build"],
          siteRoot,
          timeoutMs: BUILD_TIMEOUT_MS,
        });
        if (outcome.ok) {
          build = "pass";
        } else {
          build = "fail";
          // Prefers the actual `next build` stdout (the real compiler error) over the generic
          // failure message, matching gate.mjs:127's own `e.stdout || e.message || e`
          // preference — a bare "Build exited with code 1" is far less useful for the "one
          // targeted fix" than the compiler's own diagnostic.
          const message = outcome.stdout.length > 0 ? outcome.stdout : outcome.stderr.length > 0 ? outcome.stderr : (outcome.error ?? "build failed");
          buildViolations.push({ rule: "build-fail", file: "-", line: 0, detail: message.slice(-600) });
        }
      }

      const hard: GateViolation[] = [...tokenDrift.violations, ...brandLint.hard, ...structure.hard, ...carryForward.violations, ...buildViolations];
      const warn: GateViolation[] = [...fontFidelity.violations, ...brandLint.warn, ...structure.warn];

      const checks: LandingGateChecks = {
        tokenDrift: { colors: tokenDrift.colorCount, missing: tokenDrift.violations.filter((v) => v.rule === "token-drift").length },
        fontFidelity: fontFidelity.families.length ? fontFidelity.families : "none",
        brandLint: { forbidEmDash: brandLint.forbidEmDash, forbidEnDash: brandLint.forbidEnDash, forbidExcl: brandLint.forbidExcl },
        structure: { fileCount: files.length, componentCount: componentFiles.length },
        carryForward: { total: carryForward.total, missing: carryForward.missing },
        build,
      };

      if (hard.length === 0) {
        return success<LandingGateVerdict>({ verdict: "pass", evidence: summarizeEvidence(checks), toolVersion: TOOL_VERSION, checks });
      }

      return success<LandingGateVerdict>({
        verdict: "content_fail",
        reason: `${hard.length} hard violation(s): ${hard.map((v) => `${v.rule} (${v.file}${v.line ? `:${v.line}` : ""})`).join("; ")}`,
        evidence: hard.map((v) => v.detail),
        toolVersion: TOOL_VERSION,
        checks,
        hardViolations: hard,
        warnings: warn,
      });
    },
  });
}
