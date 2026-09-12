import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceStore } from "@agent-engine/tool-common";
import {
  createKarosMediaTools,
  readGeneratedLikenessConsent,
  type GeneratedLikenessDecision,
  type LikenessConsentRecord,
} from "../src/index.js";

/**
 * RFC-16 §5.2 — `generatedLikeness`, the owner's recorded permission for
 * third-party marks and real public figures in generated imagery.
 *
 * The shape of this file mirrors `visual-patterns.test.ts`'s consent block on
 * purpose, because the reader mirrors `readVisualPatternConsent`. Two tests
 * carry the weight:
 *
 *   - a `granted` status that names nobody grants nothing — the direct
 *     analogue of `visual-patterns.ts:186-195`. "You may use third-party
 *     marks" without saying WHICH marks is not a narrow permission, it is an
 *     uncheckable one: there is no list for anything downstream to test what
 *     was actually drawn against.
 *   - a store read that THROWS fails closed. Not "returns empty" — an
 *     unreadable consent record on a storage hiccup must not be read as
 *     "unknown, proceed", which is the exact failure a consent gate exists to
 *     prevent.
 *
 * Each of these was written by first making the reader permissive and watching
 * the assertion refuse. See the `// break it` notes.
 */

const CTX = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" } as never;

let rootDir: string;
let store: WorkspaceStore;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-likeness-"));
  store = new WorkspaceStore(rootDir);
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

function registry(withStore: WorkspaceStore = store) {
  return createKarosMediaTools({ env: {}, store: withStore, generationClient: null, scraper: null, visionClient: null });
}

async function viaTool(withStore: WorkspaceStore = store): Promise<GeneratedLikenessDecision> {
  const outcome = await registry(withStore)["media.getLikenessConsent"]!.execute({}, { ctx: CTX });
  expect(outcome.status, JSON.stringify(outcome)).toBe("success");
  return (outcome as { result: GeneratedLikenessDecision }).result;
}

/** Every refusal must look identical from the outside: no partial permit ever leaks off a denial. */
function expectGrantsNothing(decision: GeneratedLikenessDecision): void {
  expect(decision.granted).toBe(false);
  expect(decision.thirdPartyMarks).toEqual([]);
  expect(decision.publicFigures).toEqual([]);
  expect(decision.ownMarks).toBe(false);
  expect(decision.reason).toContain("no third-party marks and no public figures");
}

describe("readGeneratedLikenessConsent — the fail-closed paths", () => {
  it("a granted status that names nobody grants nothing", async () => {
    // Four shapes of the same mistake: a yes with no list, an empty `allow`,
    // explicitly empty lists with ownMarks false, and a list whose only entry
    // is whitespace. All four are a permission that cannot be checked against
    // what a model actually drew, so all four authorise nothing.
    //
    // break it: change the `thirdPartyMarks.length === 0 && ...` guard in
    // likeness-consent.ts to `return { granted: true, ... }` (i.e. treat a bare
    // `granted` as a blanket yes) and every case below fails — which is the
    // premise. This is the assertion that stops "third-party marks: yes".
    const cases: Array<[string, LikenessConsentRecord["generatedLikeness"]]> = [
      ["no allow block at all", { status: "granted" }],
      ["an empty allow block", { status: "granted", allow: {} }],
      ["explicitly empty lists and ownMarks false", { status: "granted", allow: { thirdPartyMarks: [], publicFigures: [], ownMarks: false } }],
      ["a list whose only entry is whitespace", { status: "granted", allow: { thirdPartyMarks: ["   "], publicFigures: [""] } }],
    ];

    for (const [label, generatedLikeness] of cases) {
      await store.writeJson("acme", ["client", "consent"], { generatedLikeness });

      const direct = await readGeneratedLikenessConsent(store, "acme");
      expect(direct.granted, label).toBe(false);
      expectGrantsNothing(direct);
      expect(direct.reason, label).toContain("names nothing");

      // And through the tool, because that is the only surface the workflow has.
      expectGrantsNothing(await viaTool());
    }
  });

  it("a store read that throws fails closed, it does not proceed", async () => {
    let reads = 0;
    const exploding = {
      ...store,
      readJson: async () => {
        reads += 1;
        throw new Error("store offline");
      },
    } as unknown as WorkspaceStore;

    // break it: wrap the `store.readJson` call in likeness-consent.ts in a
    // `catch { record = undefined }` that falls through to the "no record"
    // branch instead of its own — the decision is still granted:false, so a
    // result-shaped assertion would still pass. The reason text is what tells
    // the two apart, and an operator reading "no consent record exists" during
    // a storage outage is being told something false.
    const direct = await readGeneratedLikenessConsent(exploding, "acme");
    expectGrantsNothing(direct);
    expect(reads).toBe(1);
    expect(direct.reason).toContain("could not be read");
    expect(direct.reason).toContain("store offline");
    expect(direct.reason).toContain("failing closed");
    // Specifically NOT the absent-record sentence: an unreadable record is a
    // different fact about the world from a record that was never written.
    expect(direct.reason).not.toContain("no consent record exists");

    // The tool reports a plain success carrying the refusal, rather than a
    // tooling error — the caller needs the reason for the run's report, and a
    // thrown step would turn a storage hiccup into a held run.
    const outcome = await registry(exploding)["media.getLikenessConsent"]!.execute({}, { ctx: CTX });
    expect(outcome.status).toBe("success");
    expectGrantsNothing((outcome as { result: GeneratedLikenessDecision }).result);
  });

  it("grants nothing for a client with no consent record at all — the shipped fleet-wide default", async () => {
    const direct = await readGeneratedLikenessConsent(store, "acme");
    expectGrantsNothing(direct);
    expect(direct.reason).toContain("Absent consent is not implied consent");
    expectGrantsNothing(await viaTool());
  });

  it("grants nothing when the record exists but carries no generatedLikeness block", async () => {
    // The realistic case: a client who opted in to visual-pattern ingestion and
    // was never asked this separate question. One consent document, two
    // independent decisions.
    await store.writeJson("acme", ["client", "consent"], {
      visualPatternIngestion: { status: "granted", accounts: [{ platform: "instagram", username: "acmecoffee" }] },
    });

    const direct = await readGeneratedLikenessConsent(store, "acme");
    expectGrantsNothing(direct);
    expect(direct.reason).toContain("has never been asked");
  });

  it.each([["denied"], ["revoked"]])("grants nothing when the status is %s, even with a full allowlist", async (status) => {
    await store.writeJson("acme", ["client", "consent"], {
      generatedLikeness: {
        status,
        allow: { thirdPartyMarks: ["Apple", "Samsung"], publicFigures: ["Tim Cook"], ownMarks: true },
      },
    });

    const direct = await readGeneratedLikenessConsent(store, "acme");
    expectGrantsNothing(direct);
    expect(direct.reason).toContain(`is "${status}", not "granted"`);
    // The named marks must not survive the refusal: a caller reading
    // `thirdPartyMarks` without first reading `granted` still gets nothing.
    expect(direct.thirdPartyMarks).toEqual([]);
  });
});

describe("readGeneratedLikenessConsent — the granted path", () => {
  it("returns the names an owner actually wrote, with provenance and the scope note", async () => {
    await store.writeJson("acme", ["client", "consent"], {
      generatedLikeness: {
        status: "granted",
        grantedAt: "2026-09-12T09:00:00.000Z",
        grantedBy: "tomer@karoslabs.com",
        scopeNote: "Commentary posts about the handset market only.",
        allow: { thirdPartyMarks: ["Apple", "Samsung"], publicFigures: [], ownMarks: true },
      },
    });

    const decision = await readGeneratedLikenessConsent(store, "acme");
    expect(decision.granted).toBe(true);
    expect(decision.thirdPartyMarks).toEqual(["Apple", "Samsung"]);
    expect(decision.publicFigures).toEqual([]);
    expect(decision.ownMarks).toBe(true);
    expect(decision.grantedAt).toBe("2026-09-12T09:00:00.000Z");
    expect(decision.grantedBy).toBe("tomer@karoslabs.com");
    expect(decision.scopeNote).toBe("Commentary posts about the handset market only.");
    expect(decision.reason).toContain("Apple, Samsung");

    expect(await viaTool()).toEqual(decision);
  });

  it("a grant naming only the client's own marks is a real grant, and still names no third party", async () => {
    await store.writeJson("acme", ["client", "consent"], {
      generatedLikeness: { status: "granted", allow: { ownMarks: true } },
    });

    const decision = await readGeneratedLikenessConsent(store, "acme");
    expect(decision.granted).toBe(true);
    expect(decision.ownMarks).toBe(true);
    // The safe default palette includes the client's OWN marks; permitting
    // them must not quietly permit anyone else's.
    expect(decision.thirdPartyMarks).toEqual([]);
    expect(decision.publicFigures).toEqual([]);
  });

  it("trims, drops blanks and de-duplicates case-insensitively while keeping the owner's casing", async () => {
    await store.writeJson("acme", ["client", "consent"], {
      generatedLikeness: {
        status: "granted",
        allow: { thirdPartyMarks: ["  Apple ", "apple", "", "Samsung", "   "], publicFigures: ["Tim Cook", "tim cook"] },
      },
    });

    const decision = await readGeneratedLikenessConsent(store, "acme");
    // Casing is kept because these names travel into a generation prompt,
    // where "apple" and "Apple" are not equally useful.
    expect(decision.thirdPartyMarks).toEqual(["Apple", "Samsung"]);
    expect(decision.publicFigures).toEqual(["Tim Cook"]);
  });
});

describe("media.getLikenessConsent — the tool", () => {
  it("declares 1.0.0 and is registered on the media registry", () => {
    const tool = registry()["media.getLikenessConsent"];
    expect(tool).toBeDefined();
    expect(tool!.version).toBe("1.0.0");
    expect(tool!.description).toContain("Fails closed");
  });

  it("reads the same document media.ingestVisualPatterns reads consent from, and never writes to it", async () => {
    const record = { generatedLikeness: { status: "granted", allow: { thirdPartyMarks: ["Apple"] } } };
    await store.writeJson("acme", ["client", "consent"], record);

    expect((await viaTool()).thirdPartyMarks).toEqual(["Apple"]);

    // No agent may ever write this block. Reading it must leave it untouched.
    expect(await store.readJson("acme", ["client", "consent"])).toEqual(record);
  });
});
