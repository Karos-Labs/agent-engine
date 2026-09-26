import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** 2026-09-26: the Template Studio's format evidence read reddit/x rows (karoslabs b7); Instagram accounts lead now. */
describe("00c2 reads Instagram first", () => {
  it("orders the harvest's Instagram accounts, then the brief's Instagram rows, then the rest", () => {
    const src = readFileSync(new URL("../src/workflow/create-instagram-agent-workflow.ts", import.meta.url), "utf8");
    const at = src.indexOf('"00c2-gather-format-evidence"');
    const block = src.slice(at, at + 2500);
    expect(block).toContain('const harvestAccounts = (exemplarLibrary?.status === "built" ? exemplarLibrary.accounts : [])');
    expect(block).toContain('const ordered = [...harvestAccounts, ...briefRows.filter((r) => r.platform === "instagram"), ...briefRows.filter((r) => r.platform !== "instagram")];');
  });
});
