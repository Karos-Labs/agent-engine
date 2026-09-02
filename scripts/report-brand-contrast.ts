/**
 * SCRUM-393 (IGSTYLE-8) fleet contrast report.
 *
 * Runs the exact same assessment `visual-qa-pre-checks.ts`'s
 * `assessContrastFacts` computes per-attempt inside a real Instagram run —
 * text (`--fg` on `--bg`) vs `TEXT_CONTRAST_FLOOR`, and every accent-ring
 * member vs `ACCENT_GROUND_CONTRAST_FLOOR` — across EVERY client in a
 * workspace bucket, with no run required. This is what makes "which clients
 * have a sub-floor accent" answerable on demand rather than only
 * discoverable by reading ledger warn events client-by-client after the
 * fact.
 *
 * Reuses the real, exported derivation (`deriveBrandRenderTokens`) and the
 * real, exported assessment (`assessContrastFacts`) from
 * `@agent-engine/agent-instagram` — this script does not re-implement either
 * one. A brand kit that fails to derive here will fail to derive inside a
 * real run identically, by construction.
 *
 *   GCS_WORKSPACE_BUCKET=karoscmo-prod-agent-workspace npx tsx scripts/report-brand-contrast.ts
 *   npx tsx scripts/report-brand-contrast.ts                          # local file-store workspace
 *   npx tsx scripts/report-brand-contrast.ts --clients=acme,sitti     # skip auto-discovery
 *   npx tsx scripts/report-brand-contrast.ts --json                   # machine-readable
 *
 * Read-only. Never writes anything, to any backend.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  createWorkspaceStore,
  createWorkspaceStoreFromEnv,
  defaultWorkspaceRoot,
  type GcsBucketLike,
  type WorkspaceStoreLike,
} from "@agent-engine/tools";
import {
  ACCENT_GROUND_CONTRAST_FLOOR,
  TEXT_CONTRAST_FLOOR,
  assessContrastFacts,
  deriveBrandRenderTokens,
  type BrandTokens,
  type ContrastFact,
} from "@agent-engine/agent-instagram";

interface ClientReport {
  client: string;
  hasKit: boolean;
  facts: ContrastFact[];
  /** Set when `client/brand.json` exists but derived no kit at all (nothing to assess). */
  note?: string;
}

/** The minimal, unvalidated shape this script reads off `client/brand.json` — same loose contract `client.getBrand` returns. */
type RawBrand = Record<string, unknown> | undefined;

function minimalBrandTokens(instagramBrandTokens: unknown): BrandTokens {
  // This script never calls `BrandTokensSchema.parse` — it is read-only
  // fleet tooling, not a config validator, and a client whose config is
  // slightly malformed should still get its brand.json-derived contrast
  // checked rather than being skipped outright. `templateDir`/`slideTemplate`
  // are required by the TYPE but never read by `deriveBrandRenderTokens` or
  // `kitAccentCandidates` — placeholders are correct here, not a shortcut.
  const raw = (typeof instagramBrandTokens === "object" && instagramBrandTokens !== null ? instagramBrandTokens : {}) as Record<
    string,
    unknown
  >;
  return {
    templateDir: "unused",
    slideTemplate: "unused",
    ...raw,
  } as BrandTokens;
}

/** GCS: every distinct `<slug>` under `clients/<slug>/client/brand.json` — reuses `GcsBucketLike.getFiles`, no delimiter/prefixes assumption. */
async function discoverGcsClients(bucket: GcsBucketLike): Promise<string[]> {
  const [files] = await bucket.getFiles({ prefix: "clients/" });
  const slugs = new Set<string>();
  for (const file of files) {
    const m = /^clients\/([^/]+)\/client\/brand\.json$/.exec(file.name);
    if (m) slugs.add(m[1]!);
  }
  return [...slugs].sort();
}

/** File-store: every subdirectory of `<root>/clients` that has a `client/brand.json`. */
async function discoverLocalClients(rootDir: string): Promise<string[]> {
  const clientsDir = path.join(rootDir, "clients");
  let entries: string[];
  try {
    entries = (await fs.readdir(clientsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const slugs: string[] = [];
  for (const slug of entries) {
    if (await fs.stat(path.join(clientsDir, slug, "client", "brand.json")).then((s) => s.isFile(), () => false)) {
      slugs.push(slug);
    }
  }
  return slugs.sort();
}

async function assessClient(store: WorkspaceStoreLike, client: string): Promise<ClientReport> {
  const brand = (await store.readJson<Record<string, unknown>>(client, ["client", "brand"])) as RawBrand;
  if (brand === undefined) {
    return { client, hasKit: false, facts: [], note: "no client/brand.json" };
  }
  const config = await store.readJson<{ instagramBrandTokens?: unknown }>(client, ["client", "config"]);
  const brandTokens = minimalBrandTokens(config?.instagramBrandTokens);

  const kit = deriveBrandRenderTokens(brand, brandTokens);
  if (kit === undefined) {
    return { client, hasKit: false, facts: [], note: "brand.json derived no kit (no ground/fg, no accent, no logo, no handle)" };
  }

  // The whole accent ring, not just the anchor — a client whose rotation
  // has grown past one color (today: xodigital) gets every ring member
  // checked, not only slide 0's.
  const facts = assessContrastFacts(kit, kit.palette);
  return { client, hasKit: true, facts };
}

function parseArgs(argv: string[]): { clients?: string[]; json: boolean } {
  let clients: string[] | undefined;
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg.startsWith("--clients=")) {
      clients = arg
        .slice("--clients=".length)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
  }
  return clients !== undefined ? { clients, json } : { json };
}

async function main() {
  const { clients: explicitClients, json } = parseArgs(process.argv.slice(2));
  const bucketName = process.env.GCS_WORKSPACE_BUCKET;

  let store: WorkspaceStoreLike;
  let discover: () => Promise<string[]>;

  if (bucketName) {
    // Same composition-root pattern `apps/agent-server/src/wiring/workspace-store.ts`
    // uses: `@google-cloud/storage` is imported here, at the script's own
    // entry point, never inside `@agent-engine/tool-common` (see that
    // package's `GcsBucketLike` doc comment on why).
    const { Storage } = await import("@google-cloud/storage");
    const bucket = new Storage().bucket(bucketName);
    store = createWorkspaceStoreFromEnv({ gcsBucketFactory: () => bucket });
    discover = () => discoverGcsClients(bucket);
  } else {
    const rootDir = defaultWorkspaceRoot();
    store = createWorkspaceStore(rootDir);
    discover = () => discoverLocalClients(rootDir);
  }

  const clients = explicitClients ?? (await discover());
  if (clients.length === 0) {
    console.error(
      bucketName
        ? `no clients discovered under gs://${bucketName}/clients/*/client/brand.json`
        : `no clients discovered under ${defaultWorkspaceRoot()}/clients/*/client/brand.json (set GCS_WORKSPACE_BUCKET, or --clients=a,b)`,
    );
    process.exitCode = 1;
    return;
  }

  const reports: ClientReport[] = [];
  for (const client of clients) {
    reports.push(await assessClient(store, client));
  }

  if (json) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  console.log(`SCRUM-393 fleet contrast report — ${bucketName ? `gs://${bucketName}` : defaultWorkspaceRoot()}`);
  console.log(`floors: text ${TEXT_CONTRAST_FLOOR}:1, accent-on-ground ${ACCENT_GROUND_CONTRAST_FLOOR}:1\n`);

  let belowFloorCount = 0;
  for (const r of reports) {
    if (!r.hasKit) {
      console.log(`${r.client}: ${r.note}`);
      continue;
    }
    if (r.facts.length === 0) {
      console.log(`${r.client}: kit derived, but nothing to assess (no ground/fg and no accent ring)`);
      continue;
    }
    for (const fact of r.facts) {
      const flag = fact.pass ? "OK  " : "FAIL";
      if (!fact.pass) belowFloorCount++;
      console.log(`${r.client}: [${flag}] ${fact.label} — ${fact.ratio.toFixed(2)}:1 (floor ${fact.floor}:1)`);
    }
  }

  console.log(`\n${reports.length} client(s) checked, ${belowFloorCount} fact(s) below floor.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
