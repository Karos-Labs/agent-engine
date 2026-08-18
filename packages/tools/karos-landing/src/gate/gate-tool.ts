import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { z } from "zod";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";
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

const TOOL_VERSION = "1.0.0";
const execFileAsync = promisify(execFile);

export const LandingGateInputSchema = z.object({
  brand: BrandJsonSchema,
  /** Mirrors `gate.mjs --build`: runs `npm run build` in the site directory. Off by default — slow, and out of scope for most calls (e.g. a mid-MAKE check). */
  doBuild: z.boolean().default(false),
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
        try {
          // shell:true so `npm` resolves via the shell (npm.cmd on Windows) the same way
          // the legacy gate.mjs's execSync did implicitly.
          await execFileAsync("npm", ["run", "build"], { cwd: siteRoot, timeout: 300_000, shell: true });
          build = "pass";
        } catch (err) {
          build = "fail";
          // Prefers the actual `next build` stdout (the real compiler error) over the generic
          // Error.message, matching gate.mjs:127's own `e.stdout || e.message || e` preference —
          // a bare "Command failed: npm run build" message is far less useful for the "one
          // targeted fix" than the compiler's own diagnostic.
          const stdout = (err as { stdout?: unknown } | undefined)?.stdout;
          const message = typeof stdout === "string" && stdout.length > 0 ? stdout : err instanceof Error ? err.message : String(err);
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
