import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createKarosIntakeTools } from "../src/index.js";

/**
 * `intake.saveStrategy` — the write side of a client's setup documents.
 *
 * The invariants worth pinning are all about not producing a charter that
 * looks configured and is not, and about a setup run for one client being
 * unable to touch another's.
 */
let rootDir: string;
let store: WorkspaceStore;

const CTX = {
  runId: "run_1",
  clientSlug: "acme",
  productId: "linkedin-setup-agent",
  runKind: "setup",
} as never;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-intake-"));
  store = new WorkspaceStore(rootDir);
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

const tools = () => createKarosIntakeTools(store);

describe("intake.saveStrategy", () => {
  it("writes where client.getStrategy reads", async () => {
    // The two have to agree on the path or a charter exists and is never read.
    const outcome = await tools()["intake.saveStrategy"]!.execute(
      { agent: "linkedin-agent", key: "daniel-herbert", markdown: "# Seat" },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("success");
    const doc = await store.readJson<{ markdown: string }>("acme", ["strategy", "linkedin-agent", "daniel-herbert"]);
    expect(doc?.markdown).toBe("# Seat");
  });

  it("writes the agent-level document when no key is given", async () => {
    await tools()["intake.saveStrategy"]!.execute(
      { agent: "reddit-agent", markdown: "account voice" },
      { ctx: CTX },
    );

    expect((await store.readJson<{ markdown: string }>("acme", ["strategy", "reddit-agent"]))?.markdown).toBe(
      "account voice",
    );
  });

  it("refuses an empty document", async () => {
    // Worse than no charter: it reads as configured while telling the drafting
    // agent nothing.
    const outcome = await tools()["intake.saveStrategy"]!.execute(
      { agent: "linkedin-agent", markdown: "   \n  " },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("content_fail");
    expect(await store.readJson("acme", ["strategy", "linkedin-agent"])).toBeUndefined();
  });

  it("trims, so a trailing newline does not become the document", async () => {
    await tools()["intake.saveStrategy"]!.execute(
      { agent: "linkedin-agent", markdown: "  # Seat\n\n" },
      { ctx: CTX },
    );

    expect((await store.readJson<{ markdown: string }>("acme", ["strategy", "linkedin-agent"]))?.markdown).toBe(
      "# Seat",
    );
  });

  it("rejects a key that would escape the agent's folder", async () => {
    // The key becomes a path segment; for a tenant-bound store that is the
    // whole security property.
    for (const key of ["../escape", "a/b", "UPPER", "with space"]) {
      const outcome = await tools()["intake.saveStrategy"]!.execute(
        { agent: "linkedin-agent", key, markdown: "x" },
        { ctx: CTX },
      );
      expect(outcome.status, key).not.toBe("success");
    }
  });

  it("rejects an agent name outside the same charset", async () => {
    const outcome = await tools()["intake.saveStrategy"]!.execute(
      { agent: "../other-client", markdown: "x" },
      { ctx: CTX },
    );

    expect(outcome.status).not.toBe("success");
  });

  it("is tenant-bound — it takes no client argument", async () => {
    // ctx.clientSlug is the only tenant input, so a setup run for one client
    // cannot write another's charter even if the payload names one.
    await tools()["intake.saveStrategy"]!.execute(
      { agent: "linkedin-agent", markdown: "acme only" },
      { ctx: CTX },
    );

    expect(await store.readJson("other-client", ["strategy", "linkedin-agent"])).toBeUndefined();
  });

  it("records provenance alongside the document", async () => {
    // Months later, "why does this seat refuse to mention pricing" is
    // answerable by looking at where the document came from.
    await tools()["intake.saveStrategy"]!.execute(
      { agent: "linkedin-agent", markdown: "x", source: { form: "linkedin-setup", runId: "run_1" } },
      { ctx: CTX },
    );

    const doc = await store.readJson<{ source: Record<string, unknown> }>("acme", ["strategy", "linkedin-agent"]);
    expect(doc?.source).toMatchObject({ producedBy: "intake.saveStrategy", form: "linkedin-setup" });
  });

  it("overwrites on a re-run rather than duplicating", async () => {
    // Re-submitting a corrected form should replace the charter, not leave two.
    const save = tools()["intake.saveStrategy"]!;
    await save.execute({ agent: "linkedin-agent", key: "seat", markdown: "first" }, { ctx: CTX });
    await save.execute({ agent: "linkedin-agent", key: "seat", markdown: "corrected" }, { ctx: CTX });

    expect(
      (await store.readJson<{ markdown: string }>("acme", ["strategy", "linkedin-agent", "seat"]))?.markdown,
    ).toBe("corrected");
  });
});
