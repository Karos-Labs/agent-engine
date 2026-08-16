import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

/**
 * A standing regression test for RFC-01 §16.3's finding: no credential is
 * ever passed to this codebase as a literal value in source. This is not a
 * one-time audit — it's a monorepo-wide scan that runs every `npm test` in
 * `packages/core`, so a future change can't silently reintroduce a
 * hardcoded secret without a test failure. Scoped to `src/` only (never
 * `__tests__/`), since gate fixtures deliberately use secret-shaped strings
 * to test `gate.leakCheck`'s own detection logic — those are supposed to
 * look like this, and scanning them would be testing the wrong thing.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "an Anthropic/OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "an AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "a PEM private key block", pattern: /-----BEGIN(?: RSA| EC)? PRIVATE KEY-----/ },
  { label: "a GitHub personal access token", pattern: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { label: "a Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    label: "a hardcoded value assigned to a credential-shaped field",
    pattern: /\b(?:apiKey|clientSecret|privateKey|accessToken|refreshToken|password)\s*:\s*["'`][A-Za-z0-9_\-./+=]{12,}["'`]/i,
  },
];

function listSourceFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

const srcSep = `${path.sep}src${path.sep}`;
const sourceFiles = [
  ...listSourceFiles(path.join(REPO_ROOT, "packages")).filter((f) => f.includes(srcSep)),
  ...listSourceFiles(path.join(REPO_ROOT, "evals", "src")),
];

describe("secret hygiene — no plaintext credentials in source (RFC-01 §16.3)", () => {
  it("actually scanned a non-trivial number of files (the scan itself isn't silently a no-op)", () => {
    expect(sourceFiles.length).toBeGreaterThan(80);
  });

  it.each(sourceFiles.map((file) => [path.relative(REPO_ROOT, file), file] as const))("%s has no credential-shaped literal", (_label, file) => {
    const content = readFileSync(file, "utf8");
    for (const { label, pattern } of SECRET_PATTERNS) {
      expect(pattern.test(content), `${file} appears to contain ${label}`).toBe(false);
    }
  });

  it("confirms Anthropic/OpenAI SDK clients are always constructor-injected, never constructed with an inline key", () => {
    // create-model-router-from-env.ts is the one deliberate exception: its entire
    // job is being the sanctioned composition-root factory that builds the real
    // client from an env-var-sourced key (never a literal), so every other call
    // site can keep depending on the injected-client pattern instead of doing
    // this construction itself.
    const offenders = sourceFiles
      .filter((file) => !file.endsWith("create-model-router-from-env.ts"))
      .filter((file) => /new (?:Anthropic|OpenAI)\s*\(\s*\{/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
