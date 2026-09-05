import { z } from "zod";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";
import { FirebaseHostingClient, createAdcTokenProvider, hostingSiteId, previewChannelId, type TokenProvider } from "./firebase-hosting.js";

const TOOL_VERSION = "1.0.0";

export interface LandingHostingConfig {
  /** The Firebase project that owns the Hosting sites (`karoscmo`; prep and prod both deploy there under different prefixes). */
  projectId: string;
  /** Site id prefix, e.g. `karos-` (prod) or `karos-prep-`. */
  sitePrefix: string;
  /** Preview channel lifetime. Default 14 days. */
  previewTtlSeconds?: number;
}

export const DeployPageInputSchema = z.object({
  clientSlug: z.string().min(1).describe("Which client's Hosting site (<prefix><clientSlug>) to publish to."),
  runId: z.string().min(1).describe("This run's id; the preview channel id is derived from it."),
  html: z.string().min(1).describe("The assembled index.html."),
  extraFiles: z
    .array(z.object({ path: z.string().regex(/^[a-zA-Z0-9._\-/]+$/).describe("Path relative to the site root."), base64: z.string().describe("The file's bytes, base64.") }))
    .default([])
    .describe("Extra static files to ship next to the page (an og:image, a favicon)."),
  channel: z.enum(["preview", "live"]).describe("`preview`: a run-scoped, auto-expiring channel for the reviewer. `live`: the site's public URL."),
  versionName: z.string().min(1).optional().describe("Re-release an already-deployed version (the one the reviewer saw) instead of uploading again."),
});
export type DeployPageInput = z.infer<typeof DeployPageInputSchema>;

export interface DeployPageResult {
  siteId: string;
  siteCreated: boolean;
  versionName: string;
  channel: string;
  url: string;
  fileCount: number;
}

export interface DeployPageDeps {
  tokenProvider?: TokenProvider;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/**
 * `landing.deployPage` (RFC-11 §7 OUTPUT): publishes one client's page to
 * Firebase Hosting. `channel: "preview"` before the human gate hands the
 * reviewer a live URL that expires by itself; `channel: "live"` after
 * approval releases THE SAME version (pass `versionName` back) to
 * `https://<site>.web.app`, so what shipped is byte-for-byte what was
 * approved. One Hosting site per client (`<prefix><slug>`), created on first
 * use; a client's page therefore never shares a version with another's.
 */
export function createDeployPage(config: LandingHostingConfig, deps: DeployPageDeps = {}) {
  let clientPromise: Promise<FirebaseHostingClient> | undefined;
  const getClient = () =>
    (clientPromise ??= (async () => {
      const token = deps.tokenProvider ?? (await createAdcTokenProvider());
      return new FirebaseHostingClient({
        projectId: config.projectId,
        token,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
      });
    })());

  return defineTool<DeployPageInput, DeployPageResult>({
    name: "landing.deployPage",
    description:
      "Publishes the assembled landing page to Firebase Hosting: one site per client, a run-scoped auto-expiring preview channel before review, and the same version promoted to the live URL after approval.",
    version: TOOL_VERSION,
    inputSchema: DeployPageInputSchema,
    async execute({ clientSlug, runId, html, extraFiles, channel, versionName }) {
      const siteId = hostingSiteId(config.sitePrefix, clientSlug);
      try {
        const client = await getClient();
        const site = await client.ensureSite(siteId);
        let version = versionName;
        let fileCount = 1 + extraFiles.length;
        if (!version) {
          const deployed = await client.deployVersion(siteId, [
            { path: "/index.html", bytes: Buffer.from(html, "utf8") },
            ...extraFiles.map((f) => ({ path: `/${f.path.replace(/^\/+/, "")}`, bytes: Buffer.from(f.base64, "base64") })),
          ]);
          version = deployed.versionName;
          fileCount = deployed.fileCount;
        }
        const channelId = channel === "live" ? "live" : previewChannelId(runId);
        if (channel === "preview") await client.ensurePreviewChannel(siteId, channelId, config.previewTtlSeconds ?? 14 * 24 * 3600);
        const release = await client.release(siteId, channelId, version, `agent-engine run ${runId}`);
        return success<DeployPageResult>({ siteId, siteCreated: site.created, versionName: version, channel: channelId, url: release.url, fileCount });
      } catch (err) {
        return toolingError(`landing.deployPage(${channel}) for site "${siteId}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}
