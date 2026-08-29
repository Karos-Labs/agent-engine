import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { WorkspaceStore } from "@agent-engine/tool-common";
import type { AgentTool, AgentToolRegistry } from "@agent-engine/core";
import { createOfflineScraper } from "@agent-engine/tool-karos-scraper";
import {
  createAllKarosTools,
  createKarosVideoTools,
  createKarosLandingTools,
  createKarosMediaTools,
  createKarosIntakeTools,
  createLandingEngineConfigFromEnv,
} from "../src/index.js";

/**
 * SCRUM-293 (AU7): "the LLM has never seen one" — `BaseAgent.describeAllowedTools()`
 * is the ONLY place a tool's shape reaches the model, built from exactly two
 * things: `AgentTool.description` and `z.toJSONSchema(tool.inputSchema)`. This
 * test builds the SAME full registry `apps/agent-server/src/wiring/tools.ts`'s
 * `createServerTools()` assembles (every `createAllKarosTools()` entry plus
 * `video.*`/`landing.*`/`media.*`/`intake.*`, which that bundle deliberately
 * excludes) and proves every tool in it now carries that prose, rather than
 * trusting any one package's own test suite to have caught a gap.
 *
 * Depth policy, stated rather than silent: only each tool's OWN top-level
 * input-schema properties are asserted here. Several tools (e.g.
 * `intel.writeReport`, `reputation.triage`) accept large, deeply nested
 * schemas whose leaf fields were a deliberate, disclosed scope cut in
 * SCRUM-293's implementation (documented in the ticket's final report) —
 * asserting recursively would make this test fail on a known, accepted gap
 * rather than catch a new one.
 */

const KNOWN_UNDESCRIBED_TOP_LEVEL_PARAMS: ReadonlySet<string> = new Set();

function buildFullRegistry(rootDir: string): AgentToolRegistry {
  const store = new WorkspaceStore(rootDir);
  return {
    // Same nine-plus-one servers `createServerTools()` always includes.
    ...createAllKarosTools(store, undefined, { scraper: createOfflineScraper() }),
    // `video.*`/`landing.*`/`media.*`/`intake.*` — deliberately excluded from
    // `createAllKarosTools()` (see its own doc comment) but part of the real
    // server registry every deployed agent dispatches against.
    ...createKarosVideoTools({}),
    ...createKarosLandingTools(createLandingEngineConfigFromEnv({ env: {} }), undefined, store),
    ...createKarosMediaTools({}),
    ...createKarosIntakeTools(store),
  };
}

/** Every top-level property name straight off `z.toJSONSchema()`'s own `properties` bag — no recursion into nested object/array-item schemas (see depth policy above). */
function topLevelPropertyNames(tool: AgentTool<unknown, unknown>): string[] {
  const schema = z.toJSONSchema(tool.inputSchema as z.core.$ZodType) as { properties?: Record<string, unknown> };
  return Object.keys(schema.properties ?? {});
}

function topLevelPropertyDescription(tool: AgentTool<unknown, unknown>, propertyName: string): string | undefined {
  const schema = z.toJSONSchema(tool.inputSchema as z.core.$ZodType) as {
    properties?: Record<string, { description?: string }>;
  };
  return schema.properties?.[propertyName]?.description;
}

describe("Layer 3 tool registry — every tool advertises itself (SCRUM-293 / AU7)", () => {
  let rootDir: string;
  let tools: AgentToolRegistry;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-tool-descriptions-"));
    tools = buildFullRegistry(rootDir);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("builds a registry of more than the karos-only 51 (video/landing/media/intake included)", () => {
    // 51 from createAllKarosTools() (see cross-cutting.test.ts) plus video/landing/media/intake.
    expect(Object.keys(tools).length).toBeGreaterThan(51);
  });

  it("every tool in the full server registry has a non-empty description", () => {
    const missing: string[] = [];
    for (const [name, tool] of Object.entries(tools)) {
      if (typeof tool.description !== "string" || tool.description.trim().length === 0) {
        missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every tool's inputSchema produces valid JSON Schema with a description on every top-level property", () => {
    const violations: string[] = [];
    for (const [name, tool] of Object.entries(tools)) {
      let schema: { properties?: Record<string, { description?: string }> };
      try {
        schema = z.toJSONSchema(tool.inputSchema as z.core.$ZodType) as typeof schema;
      } catch (err) {
        violations.push(`${name}: inputSchema failed to convert to JSON Schema — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const [propertyName, propertySchema] of Object.entries(schema.properties ?? {})) {
        const key = `${name}.${propertyName}`;
        if (KNOWN_UNDESCRIBED_TOP_LEVEL_PARAMS.has(key)) continue;
        if (typeof propertySchema.description !== "string" || propertySchema.description.trim().length === 0) {
          violations.push(key);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("names a representative sample by name, so a future regression names the tool, not just a count", () => {
    for (const name of ["client.getBrand", "gate.numbersSourced", "video.render", "landing.gate", "media.findImages", "intake.saveStrategy"]) {
      const tool = tools[name];
      expect(tool, `expected "${name}" to be registered`).toBeDefined();
      expect(tool!.description.length).toBeGreaterThan(0);
      expect(topLevelPropertyNames(tool!).length >= 0).toBe(true); // schema conversion doesn't throw
      for (const prop of topLevelPropertyNames(tool!)) {
        expect(topLevelPropertyDescription(tool!, prop), `${name}.${prop} description`).toBeTruthy();
      }
    }
  });
});
