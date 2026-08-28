/**
 * SCRUM-325 (AU44) — the prompt registry / drift / hygiene check.
 *
 * Run: `npm run check:prompts` (wired as its own job in
 * .github/workflows/quality.yml). Exit code 1 on any problem.
 *
 * WHY THIS EXISTS. Prompts in this repo are already DB-backed, versioned and
 * CI-published with pin verification — none of that is being rebuilt. The gap
 * was that every consumer of the `agents/<agent>/prompts/` tree DISCOVERED it
 * by walking it,
 * and a walk agrees with the disk by construction. So when `blog-craft` and
 * `newsletter-craft` acquired a `latest.md` that matched none of their
 * numbered versions, nothing objected: `publish-prompts.ts` quietly minted a
 * phantom `v4` from the drifted file and repointed `latestVersion` at it, and
 * the "publish" step reported success. Three checks close that:
 *
 *   1. REGISTRY DRIFT — `scripts/prompt-registry.ts` states, by hand, which
 *      prompts exist, who owns them, which versions they have and which one
 *      `latest.md` is. It is compared against the disk. Two independent
 *      statements of one fact, required to agree.
 *   2. HYGIENE — each registry entry declares the guardrails its prompt must
 *      carry (AU31's language directive, the "never invent numbers" +
 *      `gate.numbersSourced` pair, required output-schema fields). The
 *      prompt's own text is checked against that declaration. Every `gate.*`
 *      a prompt names must also be a gate that really exists.
 *   3. PIN RESOLUTION — every `skillRef: "id@n"` in agent `src/` must name a
 *      version the registry declares.
 *
 * WHAT MAKES EACH CHECK CAPABLE OF FAILING (this repo's standing question):
 *   - registry drift fails the moment a prompt file is added, deleted or
 *     renumbered without editing the registry — a one-line edit either side;
 *   - `latest-drift` failed on this repo's real `main` when it was written:
 *     two prompts, verbatim output in the ticket's evidence;
 *   - hygiene fails when a declared marker is deleted from a prompt — which
 *     is precisely what had happened to the language directive in both
 *     drifted `latest.md` files;
 *   - `unknown-gate` fails when a prompt names a `gate.*` that
 *     `createKarosGatesTools()` does not return. It finds nothing today, and
 *     that is reported as "0 problems", never as proof it works — its own
 *     regression test drives it with a fixture that does trip it.
 *
 * `--root <dir>` points every check at a different tree (the tests use it).
 * `--json` prints machine-readable output and is what the test suite reads.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  HYGIENE_MARKERS,
  KNOWN_GATES,
  PROMPT_REGISTRY,
  REPO_ROOT,
  diffRegistryAgainstDisk,
  discoverPromptsOnDisk,
  type DiskPrompt,
  type PromptProblem,
  type PromptRegistryEntry,
} from "./prompt-registry";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** `gate.*` names any prompt mentions, resolved against what really exists. */
const GATE_MENTION = /gate\.[a-zA-Z][a-zA-Z0-9]*/g;

/** Every `skillRef: "promptId@version"` in agent `src/`. */
const SKILL_REF = /skillRef:\s*["']([a-zA-Z0-9_-]+)@(\d+)["']/g;

function hasAny(haystackLower: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystackLower.includes(n));
}

/**
 * Hygiene, asserted against the text of the version the registry calls latest
 * — the one an unpinned resolve actually serves, and the one `latest.md` is
 * required to equal.
 */
export function checkHygiene(registry: readonly PromptRegistryEntry[], disk: readonly DiskPrompt[]): PromptProblem[] {
  const problems: PromptProblem[] = [];
  const diskById = new Map(disk.map((d) => [d.promptId, d]));

  for (const entry of registry) {
    const d = diskById.get(entry.promptId);
    const text = d?.versions.get(entry.latestVersion);
    if (text === undefined) continue; // already reported as a registry/version problem
    const lower = text.toLowerCase();
    const where = `${entry.promptId}@${entry.latestVersion}`;

    if (entry.requires?.languageDirective === true && !hasAny(lower, HYGIENE_MARKERS.languageDirective)) {
      problems.push({
        kind: "hygiene-missing-marker",
        promptId: entry.promptId,
        detail: `${where} is declared to carry AU31's language directive but never mentions \`clientVoiceContext\` — a run for a non-English outlet will draft in English with nothing to catch it`,
      });
    }

    if (entry.requires?.numbersSourced === true) {
      if (!hasAny(lower, HYGIENE_MARKERS.numbersSourcedProse)) {
        problems.push({
          kind: "hygiene-missing-marker",
          promptId: entry.promptId,
          detail: `${where} is declared to carry the anti-hallucination guardrail but contains no "never invent"/"do not invent" instruction`,
        });
      }
      if (!hasAny(lower, HYGIENE_MARKERS.numbersSourcedGate)) {
        problems.push({
          kind: "hygiene-missing-marker",
          promptId: entry.promptId,
          detail: `${where} tells the model not to invent numbers but never names \`gate.numbersSourced\`, the validator that actually rejects one — an unenforced request`,
        });
      }
    }

    if (entry.requires?.structuredOutput === true) {
      const missing = (entry.structuredOutputFields ?? []).filter((f) => !text.includes(f));
      if ((entry.structuredOutputFields ?? []).length === 0) {
        problems.push({
          kind: "hygiene-missing-marker",
          promptId: entry.promptId,
          detail: `${where} declares requires.structuredOutput but lists no structuredOutputFields — a check with nothing to check is not a check`,
        });
      } else if (missing.length > 0) {
        problems.push({
          kind: "hygiene-missing-marker",
          promptId: entry.promptId,
          detail: `${where} never mentions required output field(s): ${missing.join(", ")}`,
        });
      }
    }

    // Every gate a prompt names must exist. Checked across ALL versions, not
    // just latest: an old pinned version naming a deleted gate misleads just
    // as effectively as a new one.
    for (const [version, content] of d!.versions) {
      for (const mention of new Set(content.match(GATE_MENTION) ?? [])) {
        if (!(KNOWN_GATES as readonly string[]).includes(mention)) {
          problems.push({
            kind: "unknown-gate",
            promptId: entry.promptId,
            detail: `${entry.promptId}@${version} instructs the model to satisfy \`${mention}\`, which createKarosGatesTools() does not return — known gates: ${KNOWN_GATES.join(", ")}`,
          });
        }
      }
    }
  }
  return problems;
}

/**
 * Guards `KNOWN_GATES` itself against rot. The list is a literal so this
 * script can run before `npm run build` (nothing is importable from a
 * workspace `dist/` on a fresh checkout), but a stale literal would silently
 * turn `unknown-gate` into either a false alarm or a rubber stamp. So the
 * real registration site is re-parsed here and the two must agree.
 */
export async function checkKnownGatesMatchSource(root: string = REPO_ROOT): Promise<PromptProblem[]> {
  const src = path.join(root, "packages", "tools", "karos-gates", "src", "index.ts");
  let content: string;
  try {
    content = await fs.readFile(src, "utf8");
  } catch {
    return [
      {
        kind: "unknown-gate",
        promptId: "(karos-gates)",
        detail: `cannot read ${path.relative(root, src)} to verify KNOWN_GATES — the gate list in scripts/prompt-registry.ts is unverified, not confirmed`,
      },
    ];
  }
  const registered = new Set<string>();
  for (const m of content.matchAll(/["'](gate\.[a-zA-Z][a-zA-Z0-9]*)["']\s*:/g)) registered.add(m[1]!);

  const declared = new Set<string>(KNOWN_GATES);
  const missing = [...registered].filter((g) => !declared.has(g)).sort();
  const extra = [...declared].filter((g) => !registered.has(g)).sort();
  if (missing.length === 0 && extra.length === 0) return [];
  return [
    {
      kind: "unknown-gate",
      promptId: "(karos-gates)",
      detail:
        `KNOWN_GATES in scripts/prompt-registry.ts disagrees with createKarosGatesTools()` +
        (missing.length > 0 ? ` — registered but not declared: ${missing.join(", ")}` : "") +
        (extra.length > 0 ? ` — declared but not registered: ${extra.join(", ")}` : ""),
    },
  ];
}

/**
 * Every real `skillRef` pin in agent source, checked against the REGISTRY
 * rather than against the disk. Same `src/`-only scope, and for the same
 * reason, as `publish-prompts.ts`'s own scan: `__tests__`/`evals` pin
 * deliberate nonsense like `does-not-exist@99` to exercise the graceful
 * failure path, and that string must never gate a deploy.
 */
export async function checkPins(registry: readonly PromptRegistryEntry[], root: string = REPO_ROOT): Promise<PromptProblem[]> {
  const agentsDir = path.join(root, "agents");
  const byId = new Map(registry.map((e) => [e.promptId, e]));
  const problems: PromptProblem[] = [];

  async function scanDir(dir: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__" || entry.name === "evals") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDir(full);
      } else if (entry.name.endsWith(".ts")) {
        const content = await fs.readFile(full, "utf8");
        for (const match of content.matchAll(SKILL_REF)) {
          const promptId = match[1]!;
          const version = match[2]!;
          const entryForPin = byId.get(promptId);
          if (entryForPin === undefined) {
            problems.push({
              kind: "unresolvable-pin",
              promptId,
              detail: `${path.relative(root, full)} pins "${promptId}@${version}" but PROMPT_REGISTRY has no such promptId`,
            });
          } else if (!entryForPin.versions.includes(version)) {
            problems.push({
              kind: "unresolvable-pin",
              promptId,
              detail: `${path.relative(root, full)} pins "${promptId}@${version}" but the registry declares only [${entryForPin.versions.join(", ")}]`,
            });
          }
        }
      }
    }
  }
  await scanDir(agentsDir);
  return problems;
}

export interface CheckPromptsResult {
  readonly promptCount: number;
  readonly problems: PromptProblem[];
}

export async function runCheck(root: string = REPO_ROOT, registry: readonly PromptRegistryEntry[] = PROMPT_REGISTRY): Promise<CheckPromptsResult> {
  const disk = await discoverPromptsOnDisk(root);
  const problems = [
    ...diffRegistryAgainstDisk(registry, disk),
    ...checkHygiene(registry, disk),
    ...(await checkKnownGatesMatchSource(root)),
    ...(await checkPins(registry, root)),
  ];
  return { promptCount: disk.length, problems };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag >= 0 ? path.resolve(argv[rootFlag + 1] ?? ".") : REPO_ROOT;

  const result = await runCheck(root);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${DIM}  prompt registry: ${PROMPT_REGISTRY.length} declared, ${result.promptCount} found on disk${RESET}`);
    if (result.problems.length === 0) {
      console.log(`  ${GREEN}✓${RESET} registry, latest.md, per-prompt hygiene and every skillRef pin agree`);
    } else {
      console.error();
      console.error(`${RED}ERROR: ${result.problems.length} prompt registry problem(s):${RESET}`);
      for (const p of result.problems) console.error(`  ${RED}✗${RESET} [${p.kind}] ${p.promptId}: ${p.detail}`);
      console.error();
      console.error(`${DIM}  Fix the files, or edit scripts/prompt-registry.ts if the change was intended.${RESET}`);
    }
  }
  if (result.problems.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
