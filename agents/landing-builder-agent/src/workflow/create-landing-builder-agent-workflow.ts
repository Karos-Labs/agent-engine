import type { AgentContext, AgentToolRegistry, GateResponse, GateVerdict, ModelRouter, PromptStore } from "@agent-engine/core";
import {
  WorkflowHeld,
  WorkflowToolingFailure,
  type WorkflowContext,
  runTopicGuardrail,
  readRunDirection,
  runDirectionField,
  readContextDoc,
  enforceContextDocPolicy,
  toAgentContext,
} from "@agent-engine/workflow";
import {
  assemblePage,
  stripToVisibleText,
  resolveBrandLanguage,
  type BrandJson,
  type DeployPageResult,
  type LandingIntakeResult,
  type PageBlueprint,
  type PageCheckReport,
  type PageParts,
  type RenderReport,
  type SiteCapture,
  type UploadPageResult,
} from "@agent-engine/tool-karos-landing";
import { LandingBlueprintAgent } from "../agent/landing-blueprint-agent.js";
import { LandingBuildAgent } from "../agent/landing-build-agent.js";
import { LandingFixAgent } from "../agent/landing-fix-agent.js";
import { LandingCraftVerdictAgent } from "../agent/landing-craft-verdict-agent.js";
import type { LandingBuilderWorkflowResult } from "./types.js";

export interface CreateLandingBuilderAgentWorkflowOptions {
  /** The full Layer 3 registry: `createAllKarosTools(...)` merged with `createKarosLandingTools(...)`. */
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips the mandatory human review gate (`landing_craft_review`) and records
   * a synthetic `actor: "system"` approval. Off by default: AGENT-INVOCATION.md
   * §5's rollout policy routes every result through a person until a real
   * client-count source of truth exists to flip it.
   */
  autoApprove?: boolean;
}

/** The six context documents the blueprint reads, in the order it should weigh them. */
const CONTEXT_DOC_TYPES = ["product-information", "brand-voice", "branding-guidelines", "target-audience", "market-strategy", "competitor-analysis"] as const;

/** A captured site with fewer visible words than this is a splash page, not a source of product facts. */
const MIN_CAPTURE_WORDS = 80;

const CONTENT_HOST_ALLOWLIST = ["firebasestorage.googleapis.com", "storage.googleapis.com", "fonts.gstatic.com"];

async function callTool<T>(tools: AgentToolRegistry, ctx: AgentContext, name: string, args: unknown): Promise<T> {
  const tool = tools[name];
  if (!tool) throw new WorkflowToolingFailure(`${name} is not registered in this deployment's tool registry`);
  const outcome = await tool.execute(args, { ctx });
  if (outcome.status !== "success") {
    throw new WorkflowToolingFailure(`${name} failed: ${outcome.status}${"reason" in outcome ? ` — ${outcome.reason}` : ""}`);
  }
  return outcome.result as T;
}

/** A best-effort read: `undefined` on not_available/content_fail/tooling_error, never a throw. For the optional inputs. */
async function readOptional<T>(tools: AgentToolRegistry, ctx: AgentContext, name: string, args: unknown): Promise<T | undefined> {
  const tool = tools[name];
  if (!tool) return undefined;
  try {
    const outcome = await tool.execute(args, { ctx });
    return outcome.status === "success" ? (outcome.result as T) : undefined;
  } catch (err) {
    console.error(`landing-builder: ${name} threw, continuing without it`, err);
    return undefined;
  }
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function readString(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function readStringList(input: Readonly<Record<string, unknown>>, key: string): string[] {
  const v = input[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
  if (typeof v === "string" && v.trim().length > 0) return v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return [];
}

/** The capture, minus its screenshot URLs, for the model: bytes it can read, not links it cannot. */
function captureForModel(capture: SiteCapture | undefined) {
  if (!capture) return undefined;
  const { screenshots: _screenshots, ...rest } = capture;
  return rest;
}

function summarizeChecks(check: PageCheckReport, render: RenderReport, verdict: GateVerdict | undefined): string[] {
  return [
    ...check.hard.map((v) => `check/${v.check}: ${v.message}`),
    ...render.violations.map((v) => `render: ${v}`),
    ...(verdict && verdict.verdict === "content_fail" ? [`craft: ${verdict.reason}`, ...verdict.evidence.map((e) => `craft evidence: ${e}`)] : []),
  ];
}

/**
 * `createLandingBuilderAgentWorkflow()` — Landing Builder v2 (RFC-11).
 *
 * INTAKE from what the engine already holds for every client (brand kit,
 * profile, six context documents, the optional hand-curated landing files)
 * plus a live capture of the client's current site; BLUEPRINT (Opus decides
 * every design and copy fact); BUILD (Gemini 3.1 Pro writes one
 * self-contained page as parts); ASSEMBLE + CHECK + RENDER (deterministic
 * floor and headless render with screenshots); CRAFT VERDICT (one judgment
 * pass); one FIX pass if anything failed; ARCHIVE to GCS and DEPLOY a
 * Hosting preview; the human gate; PROMOTE the same version live; persist
 * state and the deliverable.
 *
 * `wf.runKind === "recurring"` is a REVISION of the published page: the
 * last approved blueprint/parts are read back and the run direction is the
 * feedback. Without a prior state it builds fresh instead of blocking.
 */
export function createLandingBuilderAgentWorkflow(options: CreateLandingBuilderAgentWorkflowOptions) {
  const tools = options.tools;

  return async function landingBuilderAgentWorkflow(wf: WorkflowContext): Promise<LandingBuilderWorkflowResult> {
    const ctx = toAgentContext(wf);
    const runDirection = readRunDirection(wf.input);
    const assumptions: string[] = [];

    // ── 00: INTAKE — the client as the portal already describes them ──
    const intake = await wf.step.code("00-intake", async () => {
      const profile = await readOptional<Record<string, unknown>>(tools, ctx, "client.getProfile", {});
      const brandKit = await readOptional<Record<string, unknown>>(tools, ctx, "client.getBrand", {});
      const voiceRules = await readOptional<Record<string, unknown>>(tools, ctx, "client.getVoiceRules", {});
      const curated = (await readOptional<LandingIntakeResult>(tools, ctx, "landing.readIntake", {})) ?? {};
      return { profile, brandKit, voiceRules, curated };
    });
    const curatedBrand: BrandJson | undefined = intake.curated.brand;

    // ── 01: the six context documents (best-effort each; the policy step decides what absence means) ──
    const contextDocs: Record<string, string> = {};
    for (const docType of CONTEXT_DOC_TYPES) {
      const markdown = await readContextDoc(wf, tools, ctx, docType, `01-load-${docType}`);
      if (markdown) contextDocs[docType] = markdown;
    }

    // ── 02: capture the client's current site ──
    const websiteUrl =
      readString(wf.input, "website") ??
      runDirection.brief.website ??
      (typeof intake.profile?.["website"] === "string" ? (intake.profile["website"] as string) : undefined) ??
      (typeof intake.brandKit?.["website"] === "string" ? (intake.brandKit["website"] as string) : undefined);
    const capture = await wf.step.code("02-capture-site", async (): Promise<SiteCapture | null> => {
      if (!websiteUrl || !/^https?:\/\//i.test(websiteUrl)) return null;
      const tool = tools["landing.captureSite"];
      if (!tool) return null;
      const outcome = await tool.execute({ url: websiteUrl, runId: wf.runId, clientSlug: wf.clientSlug }, { ctx });
      if (outcome.status !== "success") {
        console.error(`landing-builder: landing.captureSite(${websiteUrl}) -> ${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""}`);
        return null;
      }
      return outcome.result as SiteCapture;
    });
    if (!websiteUrl) assumptions.push("no website URL on the client profile, brand kit or brief: the page is grounded in the client's documents alone, with nothing carried forward from a current site");
    else if (!capture) assumptions.push(`the current site at ${websiteUrl} could not be captured: nothing carried forward from it`);
    else if (capture.method === "fetch") assumptions.push(`the current site was read as raw HTML (no browser render): observed colours/fonts and screenshots are unavailable`);

    // ── 02b: grounding policy. landing-builder-agent's row in CONTEXT_DOC_POLICY is
    // BLOCK on product-information (SCRUM-242): a published artefact built from no
    // product facts is worse than none. v2 has a second source of published facts,
    // the client's own live site, so the block applies only when BOTH are absent. ──
    await wf.step.code("02b-grounding-policy", () => {
      if (contextDocs["product-information"] || (capture && capture.wordCount >= MIN_CAPTURE_WORDS)) {
        return { decision: "proceed", groundedIn: [...Object.keys(contextDocs), ...(capture ? ["current-site"] : [])] };
      }
      return enforceContextDocPolicy({ agentId: "landing-builder-agent", docs: { "product-information": contextDocs["product-information"] }, runKind: wf.runKind });
    });
    if (!contextDocs["product-information"]) assumptions.push("no product-information document is on file: product facts come from the current site (and the brief) only");

    // ── revision? ──
    const priorState = wf.runKind === "recurring" ? intake.curated.priorState : undefined;
    const revision = priorState !== undefined;
    if (wf.runKind === "recurring" && !priorState) assumptions.push("a revision was requested but no published build state exists for this client: built fresh");

    const brief = {
      pageGoal: readString(wf.input, "page_goal") ?? readString(wf.input, "pageGoal"),
      offer: runDirection.brief.offer ?? readString(wf.input, "offer"),
      requiredSections: readStringList(wf.input, "sections"),
      referenceUrls: readStringList(wf.input, "reference_urls"),
      audience: runDirection.brief.audience,
      tone: runDirection.brief.tone,
      cta: runDirection.brief.cta,
      proof: runDirection.brief.proof,
      mustInclude: runDirection.brief.mustInclude,
    };
    const resolvedLanguage =
      resolveBrandLanguage(curatedBrand) ?? (typeof intake.brandKit?.["language"] === "string" ? (intake.brandKit["language"] as string) : undefined);

    // ── 03: BLUEPRINT ──
    const blueprintAgent = new LandingBlueprintAgent({ router: options.router, tools, promptStore: options.promptStore });
    const blueprintResult = await wf.step.agent("03-blueprint", blueprintAgent, {
      // The run-scoped instruction someone typed in the portal, as every other
      // drafting agent receives it (apps/agent-server's run-direction coverage
      // test pins this): a fresh build reads it as direction, a revision as feedback.
      ...runDirectionField(runDirection),
      company: intake.profile?.["name"] ?? intake.brandKit?.["name"] ?? wf.clientSlug,
      profile: intake.profile,
      brandKit: intake.brandKit,
      voiceRules: intake.voiceRules,
      ...(resolvedLanguage ? { resolvedLanguage } : {}),
      contextDocs,
      currentSite: captureForModel(capture ?? undefined),
      brief,
      ...(curatedBrand ? { brandContract: curatedBrand } : {}),
      ...(intake.curated.intakeMarkdown ? { intakeMarkdown: intake.curated.intakeMarkdown } : {}),
      ...(revision ? { priorBlueprint: priorState!.blueprint, feedback: runDirection.direction ?? "(no feedback text was given; keep the page as it is and only refresh facts that changed in the sources)" } : {}),
    });
    if (blueprintResult.status !== "completed" || !blueprintResult.finalOutput) throw new WorkflowToolingFailure(`landing-blueprint step resolved to "${blueprintResult.status}"`);
    const blueprint = blueprintResult.finalOutput as PageBlueprint;
    assumptions.push(...blueprint.assumptions);

    // ── 04: BUILD ──
    const buildAgent = new LandingBuildAgent({ router: options.router, tools, promptStore: options.promptStore });
    const buildResult = await wf.step.agent("04-build", buildAgent, {
      blueprint,
      ...(revision ? { priorParts: priorState!.parts, instruction: "This is a revision: reuse the prior parts for every section the blueprint did not change; rebuild only what changed." } : {}),
    });
    if (buildResult.status !== "completed" || !buildResult.finalOutput) throw new WorkflowToolingFailure(`landing-build step resolved to "${buildResult.status}"`);
    let parts = buildResult.finalOutput as PageParts;
    assumptions.push(...parts.notes.map((n) => `build: ${n}`));

    const logo = blueprint.assets.find((a) => a.kind === "logo");
    const corpus = [
      ...Object.values(contextDocs),
      ...(capture ? [capture.title ?? "", capture.description ?? "", ...capture.headings.map((h) => h.text), ...capture.textBlocks, ...capture.ctas] : []),
      JSON.stringify(brief),
      JSON.stringify(intake.brandKit ?? {}),
      JSON.stringify(intake.voiceRules ?? {}),
      ...(curatedBrand ? [JSON.stringify(curatedBrand)] : []),
      ...(intake.curated.intakeMarkdown ? [intake.curated.intakeMarkdown] : []),
    ];
    const allowedImageHosts = [...CONTENT_HOST_ALLOWLIST, ...[hostOf(websiteUrl), hostOf(capture?.finalUrl)].filter((h): h is string => Boolean(h))];
    const lint = curatedBrand?.typography
      ? {
          ...(curatedBrand.typography.forbidEmDash !== undefined ? { forbidEmDash: curatedBrand.typography.forbidEmDash } : {}),
          ...(curatedBrand.typography.forbidEnDash !== undefined ? { forbidEnDash: curatedBrand.typography.forbidEnDash } : {}),
          ...(curatedBrand.typography.forbidExclamation !== undefined ? { forbidExclamation: curatedBrand.typography.forbidExclamation } : {}),
        }
      : undefined;
    const fontFamilies = [blueprint.typography.display, blueprint.typography.body, ...(blueprint.typography.mono ? [blueprint.typography.mono] : [])];

    // ASSEMBLE -> CHECK -> RENDER -> VERDICT, as one reusable pass so the fix round runs the identical battery.
    const gatePass = async (suffix: string, current: PageParts) => {
      const html = await wf.step.code(`05-assemble${suffix}`, () => assemblePage(blueprint, current, logo ? { ogImageUrl: logo.url } : {}));
      const check = await wf.step.code(`06-check${suffix}`, () =>
        callTool<PageCheckReport>(tools, ctx, "landing.checkPage", { html, blueprint, corpus, allowedImageHosts, ...(lint ? { lint } : {}) }),
      );
      const render = await wf.step.code(`07-render${suffix}`, () =>
        callTool<RenderReport>(tools, ctx, "landing.renderPage", { html, runId: wf.runId, clientSlug: wf.clientSlug, fontFamilies, variant: suffix ? "v2" : "v1" }),
      );
      let verdict: GateVerdict | undefined;
      if (check.pass && render.pass) {
        const craftAgent = new LandingCraftVerdictAgent({ router: options.router, tools, promptStore: options.promptStore });
        const craftResult = await wf.step.agent(`08-craft-verdict${suffix}`, craftAgent, {
          blueprint,
          brandKit: intake.brandKit,
          ...(curatedBrand ? { brandContract: curatedBrand } : {}),
          checkReport: { warnings: check.warnings, numbersSeen: check.numbersSeen },
          renderReport: render.breakpoints.map(({ screenshot: _s, ...rest }) => rest),
          buildNotes: current.notes,
          html,
        });
        verdict = craftResult.status === "completed" && craftResult.finalOutput ? (craftResult.finalOutput as GateVerdict) : { verdict: "content_fail", evidence: [], reason: `craft verdict step resolved to "${craftResult.status}"`, toolVersion: "0" };
      }
      const failed = !check.pass || !render.pass || (verdict !== undefined && verdict.verdict !== "pass");
      return { html, check, render, verdict, failed };
    };

    let pass = await gatePass("", parts);
    let fixed = false;

    // ── 09: ONE targeted fix pass, then re-check. Still failing -> needs_human. No tournament. ──
    if (pass.failed) {
      const findings = summarizeChecks(pass.check, pass.render, pass.verdict);
      const fixAgent = new LandingFixAgent({ router: options.router, tools, promptStore: options.promptStore });
      const fixResult = await wf.step.agent("09-fix", fixAgent, { blueprint, parts, findings });
      if (fixResult.status === "completed" && fixResult.finalOutput) {
        parts = fixResult.finalOutput as PageParts;
        fixed = true;
        assumptions.push(...parts.notes.map((n) => `fix: ${n}`));
        pass = await gatePass("-after-fix", parts);
      } else {
        assumptions.push(`the fix pass resolved to "${fixResult.status}"; the first build is what the reviewer sees`);
      }
    }

    const needsHuman = pass.failed;
    const { html, check, render, verdict } = pass;
    assumptions.push(...check.warnings.map((w) => `warning/${w.check}: ${w.message}`));
    const screenshots = render.breakpoints.flatMap((bp) => (bp.screenshot ? [{ label: bp.label, ...bp.screenshot }] : []));

    // ── 10: ARCHIVE to GCS (when an artifact store is configured) ──
    const uploaded = await wf.step.code("10-upload", async (): Promise<UploadPageResult | null> => {
      if (!tools["landing.uploadPage"]) return null;
      return callTool<UploadPageResult>(tools, ctx, "landing.uploadPage", {
        clientSlug: wf.clientSlug,
        runId: wf.runId,
        html,
        blueprintJson: JSON.stringify(blueprint, null, 2),
        partsJson: JSON.stringify(parts, null, 2),
      });
    });

    // ── 11: DEPLOY a preview the reviewer can open (when Hosting is configured) ──
    // Best-effort: a Hosting outage or a missing IAM grant must not lose a
    // finished, checked page. The reviewer then gets the signed GCS URL, and
    // the failure is stated in the gate payload rather than swallowed.
    const preview = await wf.step.code("11-deploy-preview", async (): Promise<DeployPageResult | { error: string } | null> => {
      if (!tools["landing.deployPage"]) return null;
      try {
        return await callTool<DeployPageResult>(tools, ctx, "landing.deployPage", { clientSlug: wf.clientSlug, runId: wf.runId, html, channel: "preview" });
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    });
    const previewDeploy = preview && "url" in preview ? preview : null;
    if (!preview) assumptions.push("Firebase Hosting is not configured on this deployment: no preview or live URL; the archived index.html is the deliverable");
    else if (!previewDeploy) assumptions.push(`preview deploy failed, so there is no .web.app preview for this run: ${(preview as { error: string }).error}`);

    // ── terminal topic guardrail on the page copy, before a person is asked to approve it ──
    await runTopicGuardrail(wf, { tools, promptStore: options.promptStore, router: options.router }, stripToVisibleText(html));

    // ── 12: the mandatory human review gate ──
    const reviewDecision: GateResponse = options.autoApprove
      ? await wf.step.code("12-human-review", () => ({ decision: "approve" as const, actor: "system", at: new Date().toISOString() }))
      : await wf.step.gate("12-human-review", {
          kind: "landing_craft_review",
          payload: {
            runId: wf.runId,
            client: wf.clientSlug,
            status: needsHuman ? "needs_human" : "ok",
            title: blueprint.meta.title,
            gate: check.pass && render.pass ? "pass" : "fail",
            craftVerdict: verdict?.verdict ?? "skipped",
            ...(previewDeploy ? { previewUrl: previewDeploy.url } : {}),
            ...(uploaded?.indexSignedUrl ? { pageUrl: uploaded.indexSignedUrl } : {}),
            // The gate UI's `images` convention: `[{ n, url }]`, rendered as slides.
            images: screenshots.flatMap((s, i) => (s.url ? [{ n: i + 1, url: s.url, label: s.label }] : [])),
            findings: summarizeChecks(check, render, verdict),
            assumptions,
            signatureMoment: blueprint.signatureMoment,
            pov: blueprint.pov,
            revision,
          },
          requiredRole: "account_manager",
          timeout: { duration: "24h", onTimeout: "hold" },
        });
    if (reviewDecision.decision !== "approve") {
      throw new WorkflowHeld(`landing craft review rejected: ${reviewDecision.reason ?? "no reason given"}`);
    }

    // ── 13: PROMOTE the reviewed version to live ──
    const live = await wf.step.code("13-deploy-live", async (): Promise<DeployPageResult | null> => {
      if (!tools["landing.deployPage"]) return null;
      // The reviewed version when the preview deployed; a fresh upload of the
      // identical, checkpointed html when the preview step failed.
      return callTool<DeployPageResult>(tools, ctx, "landing.deployPage", {
        clientSlug: wf.clientSlug,
        runId: wf.runId,
        html,
        channel: "live",
        ...(previewDeploy ? { versionName: previewDeploy.versionName } : {}),
      });
    });

    // ── 14: persist the approved build as the client's landing state ──
    await wf.step.code("14-write-state", async () => {
      if (!tools["landing.writeState"]) return null;
      return callTool<{ path: string }>(tools, ctx, "landing.writeState", {
        runId: wf.runId,
        blueprint,
        parts,
        ...(live ? { liveUrl: live.url, versionName: live.versionName } : {}),
      });
    });

    // ── 15: the deliverable ──
    const deliverableId = await wf.step.code("15-persist-deliverable", async () => {
      const result = await callTool<{ id: string }>(tools, ctx, "ledger.writeDeliverable", {
        runId: wf.runId,
        kind: "landing-page-site",
        deliverable: {
          title: blueprint.meta.title,
          description: blueprint.meta.description,
          status: needsHuman ? "needs_human" : "ok",
          gate: check.pass && render.pass ? "pass" : "fail",
          craftVerdict: verdict?.verdict ?? "skipped",
          ...(live ? { liveUrl: live.url, versionName: live.versionName } : {}),
          ...(previewDeploy ? { previewUrl: previewDeploy.url } : {}),
          ...(uploaded ? { gcsPrefix: uploaded.gcsPrefix, fileCount: uploaded.fileCount, indexSignedUrl: uploaded.indexSignedUrl } : {}),
          screenshots,
          assumptions,
          revision,
        },
      });
      return result.id;
    });

    return {
      status: needsHuman ? "needs_human" : "ok",
      client: wf.clientSlug,
      title: blueprint.meta.title,
      gate: check.pass && render.pass ? "pass" : "fail",
      craftVerdict: verdict?.verdict === "pass" ? "pass" : verdict ? "content_fail" : "skipped",
      fixed,
      ...(live ? { liveUrl: live.url, versionName: live.versionName } : {}),
      ...(previewDeploy ? { previewUrl: previewDeploy.url } : {}),
      ...(uploaded ? { gcsPrefix: uploaded.gcsPrefix } : {}),
      screenshots,
      deliverableId,
      assumptions,
      oldSite: capture?.method ?? "none",
      revision,
    };
  };
}

