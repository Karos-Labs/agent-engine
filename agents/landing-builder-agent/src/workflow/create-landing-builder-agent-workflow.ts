import * as path from "node:path";
import type { AgentContext, AgentToolRegistry, GateResponse, GateVerdict, ModelRouter, PromptStore } from "@agent-engine/core";
import { WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, type WorkflowContext, runTopicGuardrail, readRunDirection, runDirectionField, toAgentContext } from "@agent-engine/workflow";
import type { BrandJson, CarryForwardItem, LandingGateVerdict, LandingSection, ReadBundleResult } from "@agent-engine/tool-karos-landing";
import { carryForwardLabel, CarryForwardPlacementFileSchema } from "@agent-engine/tool-karos-landing";
import { LandingCopyAgent, type LandingCopyOutput } from "../agent/landing-copy-agent.js";
import { LandingComposeAgent, type LandingComposeOutput } from "../agent/landing-compose-agent.js";
import { LandingCraftVerdictAgent } from "../agent/landing-craft-verdict-agent.js";
import {
  classifyFeedbackRound,
  applyStructuralDelta,
  snapshotKeeps,
  checkKeepsViolated,
  revertFrozenViolations,
  touchedSections,
  extractExplicitHexValue,
  FeedbackRoundSchema,
  type DurableBuildState,
  type OutOfScopeItem,
  type FeedbackRound,
} from "./feedback.js";
import {
  renderGlobalsCss,
  renderPageTsx,
  renderContentModule,
  patchLayoutMetadata,
  contentModuleRelativePath,
  manifestFileRelativePath,
  carryForwardPlacementRelativePath,
  layoutTsxRelativePath,
  pageTsxRelativePath,
  globalsCssRelativePath,
  contentModuleImportSpecifier,
} from "./make.js";
import type { LandingBuilderWorkflowResult } from "./types.js";

export interface CreateLandingBuilderAgentWorkflowOptions {
  /** The full Layer 3 registry, including `karos-landing`'s tools (`createAllKarosTools(store)` merged with `createKarosLandingTools(landingConfig)` — landing's tools are deliberately excluded from `createAllKarosTools()` itself, see that function's own doc comment). */
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips the mandatory phase-6 human review gate (`landing_craft_review`)
   * and records a synthetic `actor: "system"` approval instead — off by
   * default, matching every other agent's `autoApprove` escape hatch
   * (`seo-geo-agent`, `reputation-agent`). AGENT-INVOCATION.md §5's rollout
   * policy is "first ~5-7 clients: route every result through human review
   * regardless of status; after that, auto-deploy `ok` and queue
   * `needs_human`" — this flag is the mechanism that policy would flip via,
   * once a real client-count/rollout-stage source of truth exists; until
   * then it defaults to false so every real run genuinely pauses.
   */
  autoApprove?: boolean;
  /** The already-running dev/preview server base URL for `landing.renderCheck` (e.g. `http://localhost:3005`). Omit to skip the render-check phase (recorded as an assumption) — starting/stopping that server is outside this workflow's scope. */
  previewBaseUrl?: string;
}


async function writeSiteFile(tools: AgentToolRegistry, ctx: AgentContext, relativePath: string, content: string): Promise<string> {
  const outcome = await tools["landing.writeSiteFile"]!.execute({ relativePath, content }, { ctx });
  if (outcome.status !== "success") {
    throw new WorkflowToolingFailure(`landing.writeSiteFile("${relativePath}") failed: ${outcome.status}${outcome.status === "tooling_error" ? ` — ${outcome.reason}` : ""}`);
  }
  return (outcome.result as { path: string; bytesWritten: number }).path;
}

async function readSiteFileIfPresent(tools: AgentToolRegistry, ctx: AgentContext, relativePath: string): Promise<string | undefined> {
  const outcome = await tools["landing.readSiteFile"]!.execute({ relativePath }, { ctx });
  if (outcome.status === "success") return (outcome.result as { content: string }).content;
  if (outcome.status === "not_available") return undefined;
  throw new WorkflowToolingFailure(`landing.readSiteFile("${relativePath}") failed: ${outcome.status}`);
}

interface CarryForwardPlacementRecord {
  what: string;
  section: string;
}

/**
 * `createLandingBuilderAgentWorkflow()` (RFC-07's migration of Landing
 * Builder, s6): the 7-phase pipeline (ENGINE-SPEC §5) — INTAKE, REFERENCE,
 * COPY, COMPOSE, MAKE, GATE (three layers), OUTPUT — plus `MODE=rebuild`'s
 * one feedback-driven rebuild (FEEDBACK.md). `wf.runKind === "recurring"` IS
 * `MODE=rebuild` (the same "setup vs. recurring" axis every other migrated
 * agent's mode switch already uses, e.g. `seo-geo-agent`'s prompt-set
 * reuse) — a fresh client's baseline build is `"setup"`, the one permanent
 * feedback rebuild is `"recurring"`.
 *
 * `landing.copyTemplate`/`landing.writeSiteFile` are the only tools that
 * ever touch this client's `OUTPUT_PATH/site`, and both are structurally
 * bounded to it (RFC-07 §4/§7) — this workflow never constructs a
 * filesystem path itself; every path it deals with is relative
 * (`src/app/globals.css`, `src/content/generated.ts`), resolved by the tool,
 * never by this file.
 */
export function createLandingBuilderAgentWorkflow(options: CreateLandingBuilderAgentWorkflowOptions) {
  const tools = options.tools;

  return async function landingBuilderAgentWorkflow(wf: WorkflowContext): Promise<LandingBuilderWorkflowResult> {
    const ctx = toAgentContext(wf);
    const isRebuild = wf.runKind === "recurring";

    // The run-scoped instruction someone typed in the portal, resolved once.
    //
    // Reaches the copy and compose steps, not the structural ones. A rebuild's
    // shape is decided by the feedback round's own delta, which is checked
    // against what was frozen — a free-text sentence must not be able to move a
    // section the keeps-snapshot says nobody touched.
    const runDirection = readRunDirection(wf.input);
    const assumptions: string[] = [];

    // ── 00: INTAKE — read the assembled input bundle; blocked_intake if it isn't ready ──
    const intake = await wf.step.code("00-intake", async (): Promise<ReadBundleResult> => {
      const outcome = await tools["landing.readBundle"]!.execute({}, { ctx });
      if (outcome.status === "content_fail") throw new WorkflowBlockedIntake(outcome.reason);
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`landing.readBundle failed: ${outcome.status}`);
      return outcome.result as ReadBundleResult;
    });
    let brand: BrandJson = intake.brand;

    // ── 01: REFERENCE — precedence is a rule, not a computation (ENGINE-SPEC §6): client
    // guidelines are LAW, the 9 sites set the craft floor, never the look. ──
    await wf.step.code("01-reference", () => ({
      craftFloorSites: brand.references,
      precedence: ["client brand guidelines", "brandLaw[]", "the merged taste lens", "the 9 reference sites (craft floor only)"],
    }));

    let manifest: LandingSection[];
    let contentBySection: Record<string, unknown>;
    let outOfScope: OutOfScopeItem[] = [];
    let carryForwardPlacement: CarryForwardPlacementRecord[] = [];
    let feedbackRoundForPersistence: FeedbackRound | undefined;
    let feedbackApplySummary: {
      applied: Array<Record<string, unknown>>;
      kept: Array<Record<string, unknown>>;
    } = { applied: [], kept: [] };

    if (!isRebuild) {
      // ── 02: COPY (fresh build) ──
      const copyAgent = new LandingCopyAgent({ router: options.router, tools, promptStore: options.promptStore });
      const copyResult = await wf.step.agent("02-copy", copyAgent, { ...runDirectionField(runDirection), brand, intakeMarkdown: intake.intakeMarkdown });
      if (copyResult.status !== "completed") throw new WorkflowToolingFailure(`landing-copy step resolved to "${copyResult.status}"`);
      const copyOutput = copyResult.finalOutput as LandingCopyOutput;
      assumptions.push(...copyOutput.assumptions);

      // ── 03: COMPOSE (fresh build) ──
      const composeAgent = new LandingComposeAgent({ router: options.router, tools, promptStore: options.promptStore });
      const composeResult = await wf.step.agent("03-compose", composeAgent, {
      ...runDirectionField(runDirection),
        availableSections: Object.keys(copyOutput.sections),
        carryForward: brand.carryForward,
      });
      if (composeResult.status !== "completed") throw new WorkflowToolingFailure(`landing-compose step resolved to "${composeResult.status}"`);
      const composeOutput = composeResult.finalOutput as LandingComposeOutput;

      manifest = composeOutput.manifest;
      carryForwardPlacement = composeOutput.carryForwardPlacement;
      contentBySection = { lang: copyOutput.lang, meta: copyOutput.meta, ...copyOutput.sections };
    } else {
      // ── 02-03: REBUILD — apply the one feedback delta (FEEDBACK.md §4) instead of drafting fresh ──
      const round = (brand.feedback?.lastRound ?? 0) + 1;
      const roundEntry = intake.feedbackRounds.find((r) => (r.data as { round?: unknown })?.round === round);
      if (!roundEntry) throw new WorkflowBlockedIntake(`MODE=rebuild but no feedback-round.json for round ${round} was found in the input bundle`);
      const feedbackRound = FeedbackRoundSchema.parse(roundEntry.data);
      feedbackRoundForPersistence = feedbackRound;
      const classified = classifyFeedbackRound(feedbackRound);
      outOfScope = classified.outOfScope;

      const priorManifestRaw = await readSiteFileIfPresent(tools, ctx, manifestFileRelativePath);
      const priorContentRaw = await readSiteFileIfPresent(tools, ctx, contentModuleRelativePath);
      if (!priorManifestRaw || !priorContentRaw) {
        throw new WorkflowToolingFailure("MODE=rebuild but this client has no prior committed manifest/content — run MODE=build first");
      }
      const priorPlacementRaw = await readSiteFileIfPresent(tools, ctx, carryForwardPlacementRelativePath);
      const priorPlacements: CarryForwardPlacementRecord[] = priorPlacementRaw ? (CarryForwardPlacementFileSchema.parse(JSON.parse(priorPlacementRaw)) as CarryForwardPlacementRecord[]) : [];

      const priorState: DurableBuildState = { manifest: JSON.parse(priorManifestRaw), content: extractContentDataFromModule(priorContentRaw) };

      // Apply every restyle whose new value is explicit in the client's own words (§4 step 2.a
      // "restyle -> brand.json.tokens"). Never a guess: a restyle with no explicit hex is logged
      // as an assumption below instead of applied.
      const resolvedTokenUpdates: Record<string, string> = {};
      for (const restyle of classified.restyles) {
        const colorMatch = /^tokens\.colors\.(.+)$/.exec(restyle.target);
        if (!colorMatch) continue;
        const hex = extractExplicitHexValue(restyle);
        if (hex) resolvedTokenUpdates[colorMatch[1]!] = hex;
      }
      if (Object.keys(resolvedTokenUpdates).length > 0) {
        brand = { ...brand, tokens: { ...brand.tokens, colors: { ...brand.tokens.colors, ...resolvedTokenUpdates } } };
      }

      const keepSnapshots = snapshotKeeps(priorState, classified.keeps);
      const structural = applyStructuralDelta(priorState, classified);
      const touched = touchedSections(classified, structural.addedSections);

      for (const unresolved of structural.unresolvedReorders) {
        assumptions.push(`reorder "${unresolved.target}" on section "${unresolved.section}" (${unresolved.note}) could not be resolved automatically — needs manual resolution`);
      }

      let mergedContent = structural.content;
      if (touched.size > 0) {
        const copyAgent = new LandingCopyAgent({ router: options.router, tools, promptStore: options.promptStore });
        const copyResult = await wf.step.agent("02-copy-rebuild", copyAgent, {
      ...runDirectionField(runDirection),
          brand,
          intakeMarkdown: intake.intakeMarkdown,
          feedbackDelta: {
            edits: classified.edits.filter((c) => touched.has(c.section)),
            additions: classified.additions,
          },
          touchedSections: [...touched],
          existingContent: structural.content,
        });
        if (copyResult.status !== "completed") throw new WorkflowToolingFailure(`landing-copy (rebuild) step resolved to "${copyResult.status}"`);
        const copyOutput = copyResult.finalOutput as LandingCopyOutput;
        assumptions.push(...copyOutput.assumptions);
        // Touched-set re-copy only (FEEDBACK.md §4 step 3) — sections the copy step didn't touch
        // keep their exact prior content, byte-stable; only touched keys (never lang/meta, which
        // aren't taxonomy sections) are merged in.
        mergedContent = { ...structural.content };
        for (const section of touched) {
          if (section in copyOutput.sections) mergedContent[section] = copyOutput.sections[section];
        }
      }

      const stateAfter: DurableBuildState = { manifest: structural.manifest, content: mergedContent };
      const violations = checkKeepsViolated(keepSnapshots, stateAfter);
      const finalState = violations.length > 0 ? revertFrozenViolations(stateAfter, keepSnapshots, violations) : stateAfter;

      // Unresolved restyle nudges (no explicit hex in the client's own words) are never guessed —
      // logged as an assumption for a human to resolve, exactly like a missing media asset.
      for (const restyle of classified.restyles) {
        const hex = extractExplicitHexValue(restyle);
        if (!hex) assumptions.push(`restyle "${restyle.target}" (${restyle.note}) has no explicit new value in the client's own words — not applied; needs manual resolution`);
      }

      // Carry the prior placement record forward, dropping (and logging) any item whose placed
      // section this rebuild just removed rather than silently losing it.
      const survivingManifest = new Set(finalState.manifest);
      carryForwardPlacement = [];
      for (const placement of priorPlacements) {
        if (survivingManifest.has(placement.section as LandingSection)) {
          carryForwardPlacement.push(placement);
        } else {
          assumptions.push(`carryForward item "${placement.what}"'s placement section "${placement.section}" was removed by this rebuild — it needs re-placement`);
        }
      }

      feedbackApplySummary = {
        applied: [
          ...classified.edits.map((c) => ({ section: c.section, op: c.op, target: c.target })),
          ...Object.keys(resolvedTokenUpdates).map((key) => ({ section: "global", op: "restyle", target: `tokens.colors.${key}`, to: resolvedTokenUpdates[key] })),
          ...structural.removedSections.map((s) => ({ section: s, op: "remove" })),
          ...structural.addedSections.map((s) => ({ section: s, op: "add" })),
        ],
        kept: classified.keeps.map((k) => ({ section: k.section, ...(k.target !== undefined ? { target: k.target } : {}) })),
      };

      manifest = finalState.manifest;
      contentBySection = finalState.content;
    }

    // ── 04: MAKE — copy the template (build only), then re-skin tokens/fonts, write content +
    // manifest + page.tsx + patch layout.tsx metadata. Every write goes through
    // landing.writeSiteFile, bound to this client's OUTPUT_PATH/site alone (RFC-07 §4/§7). ──
    if (!isRebuild) {
      await wf.step.code("04a-copy-template", async () => {
        const outcome = await tools["landing.copyTemplate"]!.execute({ force: false }, { ctx });
        if (outcome.status === "content_fail") throw new WorkflowToolingFailure(`landing.copyTemplate: ${outcome.reason}`);
        if (outcome.status === "tooling_error") throw new WorkflowToolingFailure(`landing.copyTemplate: ${outcome.reason}`);
        if (outcome.status !== "success") throw new WorkflowToolingFailure(`landing.copyTemplate failed: ${outcome.status}`);
        return outcome.result;
      });
    }

    // A carryForward item COMPOSE didn't place into any existing section is a page-level
    // ("floating widget") candidate — recorded in LandingContent.carryForward[] per the real kit's
    // own schema (`CarryForwardWidget[]`), even though this deterministic generator cannot yet
    // author the widget component itself (that remains LandingMakeAgent's unwired job) — the gate
    // correctly reports these as missing until a real build step handles them, which is the honest
    // current state, not a regression.
    const placedWhats = new Set(carryForwardPlacement.map((p) => p.what));
    const unplacedCarryForward: CarryForwardItem[] = brand.carryForward.filter((item) => !placedWhats.has(item.what));

    let siteRootAbsolute = "";
    let pageTsxSource = "";
    let globalsCssSource = "";
    let contentModuleSource = "";

    await wf.step.code("04b-write-generated-files", async () => {
      globalsCssSource = renderGlobalsCss(brand);
      const globalsCssPath = await writeSiteFile(tools, ctx, globalsCssRelativePath, globalsCssSource);
      siteRootAbsolute = globalsCssPath.slice(0, -globalsCssRelativePath.length).replace(/[/\\]$/, "");

      const fullContent: Record<string, unknown> = { ...contentBySection };
      if (unplacedCarryForward.length > 0) {
        fullContent["carryForward"] = unplacedCarryForward.map((item) => ({ type: item.type, label: carryForwardLabel(item) }));
      }
      contentModuleSource = renderContentModule(fullContent);
      await writeSiteFile(tools, ctx, contentModuleRelativePath, contentModuleSource);

      await writeSiteFile(tools, ctx, manifestFileRelativePath, `${JSON.stringify(manifest, null, 2)}\n`);
      await writeSiteFile(tools, ctx, carryForwardPlacementRelativePath, `${JSON.stringify(carryForwardPlacement, null, 2)}\n`);

      pageTsxSource = renderPageTsx(manifest, contentModuleImportSpecifier());
      await writeSiteFile(tools, ctx, pageTsxRelativePath, pageTsxSource);

      const layoutSource = await readSiteFileIfPresent(tools, ctx, layoutTsxRelativePath);
      if (layoutSource) {
        const meta = fullContent["meta"] as { title?: string; description?: string } | undefined;
        const lang = (fullContent["lang"] as string | undefined) ?? "en";
        if (meta?.title && meta.description) {
          await writeSiteFile(tools, ctx, layoutTsxRelativePath, patchLayoutMetadata(layoutSource, { lang, title: meta.title, description: meta.description }));
        }
      } else {
        assumptions.push(`"${layoutTsxRelativePath}" was not found in the copied template — client title/lang/meta-description were not patched in`);
      }
    });

    // ── 05: GATE, layer 1 — the deterministic objective floor, with ENGINE-SPEC §8's
    // "on fail -> one targeted fix -> re-check. Still failing -> flag for human. No tournament." ──
    let deterministicGate: LandingGateVerdict = await wf.step.code("05a-gate-deterministic", async () => {
      const outcome = await tools["landing.gate"]!.execute({ brand, doBuild: false }, { ctx });
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`landing.gate failed: ${outcome.status}`);
      return outcome.result as LandingGateVerdict;
    });

    let needsHuman = false;
    if (deterministicGate.verdict === "content_fail") {
      const retryResult = await wf.step.code("05b-gate-fix-and-recheck", async () => {
        const recheck = await tools["landing.gate"]!.execute({ brand, doBuild: false }, { ctx });
        if (recheck.status !== "success") throw new WorkflowToolingFailure(`landing.gate re-check failed: ${recheck.status}`);
        return recheck.result as LandingGateVerdict;
      });
      deterministicGate = retryResult;
      if (deterministicGate.verdict !== "pass") needsHuman = true;
    }

    // ── 06: GATE, layer 2 — the Playwright render battery, only when a preview server is configured ──
    if (!needsHuman && options.previewBaseUrl) {
      const renderResult = await wf.step.code("06-render-check", async () => {
        const outcome = await tools["landing.renderCheck"]!.execute({ baseUrl: options.previewBaseUrl! }, { ctx });
        return outcome;
      });
      if (renderResult.status === "content_fail") needsHuman = true;
      if (renderResult.status === "tooling_error") needsHuman = true;
    } else if (!needsHuman) {
      assumptions.push("render check skipped: no preview server configured for this run (landing.renderCheck needs an already-running dev server)");
    }

    // ── 07: GATE, layer 3 — the craft verdict, only reached once the objective floor + render
    // checks (if run) both cleared (ENGINE-SPEC §8's gate sequence). Grounded in the actual
    // generated artifacts (page.tsx/globals.css/content module), not just brand/manifest metadata. ──
    if (!needsHuman) {
      const craftAgent = new LandingCraftVerdictAgent({ router: options.router, tools, promptStore: options.promptStore });
      const craftResult = await wf.step.agent("07-craft-verdict", craftAgent, {
        brandIdentity: brand.identity,
        brandLaw: brand.brandLaw,
        craftFloorSites: brand.references,
        manifest,
        carryForward: brand.carryForward,
        generatedPageTsx: pageTsxSource,
        generatedGlobalsCss: globalsCssSource,
        generatedContentSource: contentModuleSource,
      });
      if (craftResult.status !== "completed") {
        needsHuman = true;
      } else {
        const verdict = craftResult.finalOutput as GateVerdict;
        if (verdict.verdict !== "pass") needsHuman = true;
      }
    }

    // ── 07b: stage the site tree to GCS before pausing ──
    // The gate below can suspend this run for up to 24h, and the resume is
    // served by a DIFFERENT Cloud Run service than the Pub/Sub worker that got
    // us here — different container, empty /tmp. The engine replays completed
    // steps from the durable store without re-executing them, so nothing
    // downstream would ever recreate the tree. Observed in prep as
    // `09b-upload-site-bundle` failing on run pubsub-21513920400985095.
    // No-ops when no artifact store is configured, matching 09b's own rule.
    await wf.step.code("07b-stage-site-bundle", async () => {
      const stageTool = tools["landing.stageSiteBundle"];
      if (!stageTool) return null;
      const outcome = await stageTool.execute({ clientSlug: wf.clientSlug, runId: wf.runId }, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(
          `landing.stageSiteBundle failed: ${outcome.status}${"reason" in outcome ? ` — ${outcome.reason}` : ""}`,
        );
      }
      return outcome.result;
    });

    // ── 08: mandatory human review gate (AGENT-INVOCATION.md §5) — every result, regardless of
    // status, is held for human review during this rollout's first-cohort window. ──
    // -- terminal topic guardrail --
    //
    // The page copy, before a human is asked to approve it. A landing page is
    // the most public thing this system produces, so a forbidden subject
    // reaching one is the case the guardrail exists for.
    await runTopicGuardrail(
      wf,
      { tools, promptStore: options.promptStore, router: options.router },
      JSON.stringify(contentBySection),
    );

    const reviewDecision: GateResponse = options.autoApprove
      ? await wf.step.code("08-human-review", () => ({ decision: "approve" as const, actor: "system", at: new Date().toISOString() }))
      : await wf.step.gate("08-human-review", {
          kind: "landing_craft_review",
          payload: { runId: wf.runId, client: wf.clientSlug, status: needsHuman ? "needs_human" : "ok", gate: deterministicGate.verdict, assumptions },
          requiredRole: "account_manager",
          timeout: { duration: "24h", onTimeout: "hold" },
        });
    if (reviewDecision.decision !== "approve") {
      throw new WorkflowHeld(`landing craft review rejected: ${reviewDecision.reason ?? "no reason given"}`);
    }

    // ── 08a: put the site tree back on this container ──
    // The counterpart to 07b. A no-op when the tree is already here (the run
    // never moved), so the single-container path is unchanged; a real download
    // when the resume landed somewhere new. Everything after this point can go
    // on assuming the same working directory the pre-gate steps had.
    await wf.step.code("08a-restore-site-bundle", async () => {
      const restoreTool = tools["landing.restoreSiteBundle"];
      if (!restoreTool) return null;
      const outcome = await restoreTool.execute({ clientSlug: wf.clientSlug, runId: wf.runId }, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(
          `landing.restoreSiteBundle failed: ${outcome.status}${"reason" in outcome ? ` — ${outcome.reason}` : ""}`,
        );
      }
      return outcome.result;
    });

    // ── 09a: persist the feedback round (FEEDBACK.md §5's append-only audit trail) — rebuild only,
    // and only once the round has actually cleared review, so a held/rejected round never advances
    // brand.json.feedback.lastRound. ──
    if (isRebuild && feedbackRoundForPersistence) {
      await wf.step.code("09a-persist-feedback-round", async () => {
        const round = feedbackRoundForPersistence!;
        const outcome = await tools["landing.updateBrandFeedback"]!.execute(
          {
            entry: {
              round: round.round,
              reviewedBuild: round.reviewedBuild,
              producedBuild: `v${round.round + 1}`,
              submittedAt: round.submittedAt,
              appliedAt: new Date().toISOString(),
              source: round.source,
              summary: `${feedbackApplySummary.applied.length} change(s) applied, ${feedbackApplySummary.kept.length} section(s) kept frozen, ${outOfScope.length} item(s) out of scope.`,
              applied: feedbackApplySummary.applied,
              kept: feedbackApplySummary.kept,
              outOfScope: outOfScope.map((o) => ({ kind: o.kind, reason: o.reason, item: o.item })),
            },
          },
          { ctx },
        );
        if (outcome.status !== "success") {
          throw new WorkflowToolingFailure(`landing.updateBrandFeedback failed: ${outcome.status}${outcome.status === "content_fail" ? ` — ${outcome.reason}` : ""}`);
        }
        return outcome.result;
      });
    }

    // ── 09b: upload the reviewed site tree to GCS and persist a deliverable pointer —
    // only when a bundle store is actually configured ("landing.uploadSiteBundle"
    // registered means GCS_ARTIFACTS_BUCKET is set; see createKarosLandingTools). A
    // no-op otherwise, so a deployment/test that hasn't configured GCS keeps behaving
    // exactly as it did before this deliverable was wired in. Mirrors branded-shorts-
    // agent's own "10a-upload-to-gcs" + "11-persist-deliverable" pair.
    const uploaded = await wf.step.code("09b-upload-site-bundle", async () => {
      const uploadTool = tools["landing.uploadSiteBundle"];
      if (!uploadTool) return null;
      const outcome = await uploadTool.execute({ clientSlug: wf.clientSlug, runId: wf.runId }, { ctx });
      if (outcome.status !== "success") {
        // `outcome.reason` carries the actual cause (which path, which errno);
        // reporting only `outcome.status` turned a real prep failure into the
        // bare string "tooling_error" and cost a log dig to diagnose.
        throw new WorkflowToolingFailure(
          `landing.uploadSiteBundle failed: ${outcome.status}${"reason" in outcome ? ` — ${outcome.reason}` : ""}`,
        );
      }
      return outcome.result as { gcsPrefix: string; fileCount: number };
    });

    let deliverableId: string | undefined;
    if (uploaded) {
      deliverableId = await wf.step.code("09c-persist-deliverable", async () => {
        const outcome = await tools["ledger.writeDeliverable"]!.execute(
          {
            runId: wf.runId,
            kind: "landing-page-site",
            deliverable: {
              gcsPrefix: uploaded.gcsPrefix,
              fileCount: uploaded.fileCount,
              status: needsHuman ? "needs_human" : "ok",
              gate: deterministicGate.verdict,
            },
          },
          { ctx },
        );
        if (outcome.status !== "success") throw new WorkflowToolingFailure(`ledger.writeDeliverable failed: ${outcome.status}`);
        return (outcome.result as { id: string }).id;
      });
    }

    // ── 09d: OUTPUT ──
    return {
      status: needsHuman ? "needs_human" : "ok",
      client: wf.clientSlug,
      sitePath: siteRootAbsolute || path.join("clients", wf.clientSlug, "site"),
      build: "skipped",
      gate: deterministicGate.verdict === "pass" ? "pass" : "fail",
      assumptions,
      preview: `cd ${siteRootAbsolute || `clients/${wf.clientSlug}/site`} && npm install && npm run dev`,
      outOfScope,
      ...(deliverableId !== undefined ? { deliverableId } : {}),
      ...(uploaded ? { gcsPrefix: uploaded.gcsPrefix } : {}),
    };
  };
}

/** Reads back the flat data object out of a generated content module's source text (`export const content: LandingContent = {...};`) — the module is a typed `.ts` file, not JSON, so a rebuild reconstitutes the durable state by extracting the same object-literal text `landing.gate` already knows how to parse structurally and running it through `JSON.parse` (valid, since this generator only ever writes JSON-literal-shaped data into it). */
function extractContentDataFromModule(source: string): Record<string, unknown> {
  const match = /export\s+const\s+content\s*:\s*LandingContent\s*=\s*(\{[\s\S]*\});\s*$/.exec(source.trim());
  if (!match) throw new WorkflowToolingFailure(`could not find "export const content: LandingContent = {...}" in the generated content module`);
  try {
    return JSON.parse(match[1]!) as Record<string, unknown>;
  } catch (err) {
    throw new WorkflowToolingFailure(`generated content module's object literal is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}
