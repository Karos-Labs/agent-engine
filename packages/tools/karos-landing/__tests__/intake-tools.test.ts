import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createReadLandingIntake, createWriteLandingState } from "../src/state/intake-tools.js";
import { sampleBlueprint, sampleParts, testCtx } from "./fixtures.js";

describe("landing.readIntake / landing.writeState", () => {
  let root: string;
  let store: WorkspaceStore;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "landing-intake-"));
    store = new WorkspaceStore(root);
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it("returns an empty result for a client with no hand-curated inputs, never a failure", async () => {
    const outcome = await createReadLandingIntake(store).execute({}, { ctx: testCtx() });
    expect(outcome).toEqual({ status: "success", result: {} });
  });

  it("reads brand.json and intake.json when present, tolerating a v1 brand contract with tokens/fonts", async () => {
    await store.writeJson("northwind", ["landing", "brand"], {
      client: "northwind",
      tokens: { colors: { ink: "#141210" }, roles: { ground: "ink" } },
      fonts: { display: "Inter Tight", body: "Inter" },
      typography: { forbidEmDash: true },
      brandLaw: ["Sentence case everywhere."],
      carryForward: [{ type: "tool", what: "Booking widget" }],
    });
    await store.writeJson("northwind", ["landing", "intake"], { markdown: "# Intake\nOne primary action." });
    const outcome = await createReadLandingIntake(store).execute({}, { ctx: testCtx() });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.brand?.brandLaw).toEqual(["Sentence case everywhere."]);
    expect(outcome.result.brand?.typography?.forbidEmDash).toBe(true);
    expect(outcome.result.intakeMarkdown).toContain("One primary action");
    expect(outcome.result.priorState).toBeUndefined();
  });

  it("refuses a malformed brand.json loudly (tooling_error) rather than building on half a contract", async () => {
    await store.writeJson("northwind", ["landing", "brand"], { brandLaw: "not an array" });
    const outcome = await createReadLandingIntake(store).execute({}, { ctx: testCtx() });
    expect(outcome.status).toBe("tooling_error");
  });

  it("round-trips the published build state, and ignores a state file of an older shape", async () => {
    const written = await createWriteLandingState(store).execute(
      { runId: "run_1", blueprint: sampleBlueprint(), parts: sampleParts(), liveUrl: "https://karos-northwind.web.app", versionName: "sites/karos-northwind/versions/v1" },
      { ctx: testCtx() },
    );
    expect(written.status).toBe("success");
    const read = await createReadLandingIntake(store).execute({}, { ctx: testCtx() });
    if (read.status !== "success") throw new Error("unreachable");
    expect(read.result.priorState?.runId).toBe("run_1");
    expect(read.result.priorState?.liveUrl).toBe("https://karos-northwind.web.app");
    expect(read.result.priorState?.blueprint.sections.map((s) => s.id)).toEqual(["nav", "hero", "how-it-works", "contact", "footer"]);

    await store.writeJson("northwind", ["landing", "state"], { manifest: ["nav"], content: {} });
    const stale = await createReadLandingIntake(store).execute({}, { ctx: testCtx() });
    if (stale.status !== "success") throw new Error("unreachable");
    expect(stale.result.priorState).toBeUndefined();
  });
});
