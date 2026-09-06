import { describe, expect, it } from "vitest";
import { FirebaseHostingClient, hostingSiteId, previewChannelId } from "../src/hosting/firebase-hosting.js";
import { createDeployPage } from "../src/hosting/deploy-page-tool.js";
import { fakeHostingFetch, fakeToken, testCtx } from "./fixtures.js";

describe("hostingSiteId / previewChannelId", () => {
  it("builds a valid, prefixed, globally-unique-enough site id", () => {
    expect(hostingSiteId("karos-", "karoslabs")).toBe("karos-karoslabs");
    expect(hostingSiteId("karos-prep-", "Northwind_Corp Inc.")).toBe("karos-prep-northwind-corp-inc");
    expect(hostingSiteId("k-", "a")).toBe("k-a-site");
    expect(hostingSiteId("karos-", "a-very-long-client-slug-that-keeps-going-forever").length).toBeLessThanOrEqual(30);
  });

  it("derives a stable, short channel id from a run id", () => {
    const a = previewChannelId("pubsub-20278561164758043");
    expect(a).toMatch(/^run-[0-9a-f]{10}$/);
    expect(previewChannelId("pubsub-20278561164758043")).toBe(a);
    expect(previewChannelId("other")).not.toBe(a);
  });
});

describe("FirebaseHostingClient", () => {
  it("creates the site when it does not exist, deploys a version through populateFiles/upload/finalize, and releases to a preview channel", async () => {
    const { fetchImpl, calls } = fakeHostingFetch();
    const client = new FirebaseHostingClient({ projectId: "karoscmo", token: fakeToken, fetchImpl });

    const site = await client.ensureSite("karos-northwind");
    expect(site.created).toBe(true);

    const deployed = await client.deployVersion("karos-northwind", [{ path: "/index.html", bytes: Buffer.from("<html></html>") }, { path: "/og.png", bytes: Buffer.from([1, 2, 3]) }]);
    expect(deployed).toEqual({ versionName: "sites/karos-northwind/versions/v1", fileCount: 2, uploadedCount: 2 });

    const channel = await client.ensurePreviewChannel("karos-northwind", "run-abc", 1_209_600);
    expect(channel.url).toBe("https://karos-northwind--run-abc.web.app");
    const release = await client.release("karos-northwind", "run-abc", deployed.versionName);
    expect(release.url).toBe("https://karos-northwind--run-abc.web.app");

    const sequence = calls.map((c) => `${c.method} ${c.url.replace(/^https:\/\/firebasehosting\.googleapis\.com\/v1beta1/, "")}`);
    expect(sequence).toEqual([
      "GET /projects/karoscmo/sites/karos-northwind",
      "POST /projects/karoscmo/sites?siteId=karos-northwind",
      "POST /sites/karos-northwind/versions",
      "POST /sites/karos-northwind/versions/v1:populateFiles",
      expect.stringMatching(/^POST https:\/\/upload\.example\/upload\/[0-9a-f]{64}$/),
      expect.stringMatching(/^POST https:\/\/upload\.example\/upload\/[0-9a-f]{64}$/),
      "PATCH /sites/karos-northwind/versions/v1?updateMask=status",
      "GET /sites/karos-northwind/channels/run-abc",
      "POST /sites/karos-northwind/channels?channelId=run-abc",
      "GET /sites/karos-northwind/channels/run-abc",
      "POST /sites/karos-northwind/channels/run-abc/releases?versionName=sites%2Fkaros-northwind%2Fversions%2Fv1",
    ]);
    // Every call carries the quota project and the bearer token.
    const populate = calls.find((c) => c.url.endsWith(":populateFiles"))!;
    expect(Object.keys((populate.body as { files: Record<string, string> }).files)).toEqual(["/index.html", "/og.png"]);
  });

  it("uploads nothing Hosting already has (dedupe by hash), and the live release needs no channel lookup", async () => {
    const { fetchImpl, calls } = fakeHostingFetch({ siteExists: true, requiredHashes: "none" });
    const client = new FirebaseHostingClient({ projectId: "karoscmo", token: fakeToken, fetchImpl });
    const deployed = await client.deployVersion("karos-northwind", [{ path: "/index.html", bytes: Buffer.from("<html></html>") }]);
    expect(deployed.uploadedCount).toBe(0);
    const release = await client.release("karos-northwind", "live", deployed.versionName);
    expect(release.url).toBe("https://karos-northwind.web.app");
    expect(calls.some((c) => c.url.startsWith("https://upload.example"))).toBe(false);
  });

  it("surfaces a non-404 API error with its status and body rather than treating it as 'create the site'", async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ error: { message: "PERMISSION_DENIED: firebasehosting.sites.get" } }), { status: 403 });
    const client = new FirebaseHostingClient({ projectId: "karoscmo", token: fakeToken, fetchImpl });
    await expect(client.ensureSite("karos-northwind")).rejects.toThrow(/403.*PERMISSION_DENIED/);
  });
});

describe("landing.deployPage", () => {
  it("preview then live: the live release re-uses the reviewed version instead of uploading again", async () => {
    const { fetchImpl, calls } = fakeHostingFetch();
    const tool = createDeployPage({ projectId: "karoscmo", sitePrefix: "karos-" }, { tokenProvider: fakeToken, fetchImpl });
    const ctx = testCtx();

    const preview = await tool.execute({ clientSlug: "northwind", runId: "pubsub-1", html: "<html></html>", channel: "preview", extraFiles: [] }, { ctx });
    expect(preview.status).toBe("success");
    if (preview.status !== "success") throw new Error("unreachable");
    expect(preview.result.siteId).toBe("karos-northwind");
    expect(preview.result.siteCreated).toBe(true);
    expect(preview.result.url).toMatch(/^https:\/\/karos-northwind--run-[0-9a-f]{10}\.web\.app$/);

    const versionsBefore = calls.filter((c) => /\/versions$/.test(c.url)).length;
    const live = await tool.execute({ clientSlug: "northwind", runId: "pubsub-1", html: "<html></html>", channel: "live", versionName: preview.result.versionName, extraFiles: [] }, { ctx });
    expect(live.status).toBe("success");
    if (live.status !== "success") throw new Error("unreachable");
    expect(live.result.url).toBe("https://karos-northwind.web.app");
    expect(live.result.versionName).toBe(preview.result.versionName);
    expect(calls.filter((c) => /\/versions$/.test(c.url)).length).toBe(versionsBefore);
  });

  it("reports a Hosting failure as tooling_error naming the site, never a throw", async () => {
    const fetchImpl: typeof fetch = async () => new Response("boom", { status: 500 });
    const tool = createDeployPage({ projectId: "karoscmo", sitePrefix: "karos-" }, { tokenProvider: fakeToken, fetchImpl });
    const outcome = await tool.execute({ clientSlug: "northwind", runId: "r", html: "<html></html>", channel: "preview", extraFiles: [] }, { ctx: testCtx() });
    expect(outcome.status).toBe("tooling_error");
    if (outcome.status !== "tooling_error") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/karos-northwind.*500/);
  });
});
