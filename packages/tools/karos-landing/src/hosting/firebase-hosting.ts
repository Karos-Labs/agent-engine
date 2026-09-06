import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

/**
 * A minimal Firebase Hosting REST client (v1beta1), enough to publish one
 * static page per client with nothing but ADC.
 *
 * Why Firebase Hosting, and why REST rather than the CLI or a git push:
 * - Free tier (10 GB stored, 360 MB/day served), global CDN, HTTPS, a
 *   `<site>.web.app` URL per client and custom domains later; nothing to
 *   provision per client beyond one `sites.create` call.
 * - The worker already runs as a GCP service account with ADC. Granting it
 *   `roles/firebasehosting.admin` on the Firebase project is the whole
 *   credential story. A GitHub-Pages-style flow would need a personal token
 *   in Secret Manager, a public repo per client, and a push from a Cloud Run
 *   container, three moving parts for the same static file.
 * - Preview channels give the reviewer a real URL BEFORE the human gate
 *   (`<site>--run-xyz.web.app`, auto-expiring), and the approve step promotes
 *   the exact same version to `live`. No rebuild between what was reviewed
 *   and what shipped.
 *
 * The deploy sequence Firebase requires: create a version, tell it which
 * files exist (path -> sha256 of the GZIPPED bytes), upload the hashes it
 * does not already have, finalize the version, then create a release on a
 * channel. `populateFiles` deduplicates by hash, so redeploying an unchanged
 * screenshot costs nothing.
 */

export interface TokenProvider {
  getAccessToken(): Promise<string>;
}

export interface FirebaseHostingClientOptions {
  projectId: string;
  token: TokenProvider;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export interface HostingFile {
  /** Absolute path within the site, e.g. `/index.html`. */
  path: string;
  bytes: Buffer;
}

export interface DeployedVersion {
  versionName: string;
  fileCount: number;
  uploadedCount: number;
}

export interface HostingReleaseResult {
  releaseName: string;
  url: string;
}

const API = "https://firebasehosting.googleapis.com/v1beta1";

export class FirebaseHostingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class FirebaseHostingClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: FirebaseHostingClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? API;
  }

  private async request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const token = await this.options.token.getAccessToken();
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "x-goog-user-project": this.options.projectId,
        ...(body !== undefined && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}),
        ...extraHeaders,
      },
      ...(body !== undefined ? { body: body instanceof Uint8Array ? body : JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new FirebaseHostingError(`firebase hosting ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }

  /** Returns the site's default URL, creating the site when it does not exist yet. */
  async ensureSite(siteId: string): Promise<{ name: string; defaultUrl: string; created: boolean }> {
    try {
      const site = await this.request<{ name: string; defaultUrl: string }>("GET", `/projects/${this.options.projectId}/sites/${siteId}`);
      return { ...site, created: false };
    } catch (err) {
      if (!(err instanceof FirebaseHostingError) || err.status !== 404) throw err;
    }
    const site = await this.request<{ name: string; defaultUrl: string }>("POST", `/projects/${this.options.projectId}/sites?siteId=${encodeURIComponent(siteId)}`, {});
    return { ...site, created: true };
  }

  async deployVersion(siteId: string, files: HostingFile[]): Promise<DeployedVersion> {
    const version = await this.request<{ name: string }>("POST", `/sites/${siteId}/versions`, {
      config: {
        cleanUrls: true,
        trailingSlashBehavior: "REMOVE",
        headers: [
          { glob: "**/*.@(png|jpg|jpeg|webp|svg|ico)", headers: { "Cache-Control": "public, max-age=604800" } },
          { glob: "**/*.html", headers: { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } },
        ],
      },
    });

    const gzipped = new Map<string, { hash: string; body: Buffer }>();
    const manifest: Record<string, string> = {};
    for (const file of files) {
      const body = gzipSync(file.bytes, { level: 9 });
      const hash = createHash("sha256").update(body).digest("hex");
      gzipped.set(hash, { hash, body });
      manifest[file.path] = hash;
    }

    const populate = await this.request<{ uploadRequiredHashes?: string[]; uploadUrl: string }>("POST", `/${version.name}:populateFiles`, { files: manifest });
    const required = populate.uploadRequiredHashes ?? [];
    for (const hash of required) {
      const entry = gzipped.get(hash);
      if (!entry) throw new Error(`firebase hosting asked for hash ${hash} that no local file produced`);
      const token = await this.options.token.getAccessToken();
      const res = await this.fetchImpl(`${populate.uploadUrl}/${hash}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "x-goog-user-project": this.options.projectId },
        body: new Uint8Array(entry.body),
      });
      if (!res.ok) throw new FirebaseHostingError(`firebase hosting upload of ${hash} -> ${res.status}`, res.status);
    }

    await this.request("PATCH", `/${version.name}?updateMask=status`, { status: "FINALIZED" });
    return { versionName: version.name, fileCount: files.length, uploadedCount: required.length };
  }

  /** A preview channel that expires on its own; idempotent on re-run of the same id. */
  async ensurePreviewChannel(siteId: string, channelId: string, ttlSeconds: number): Promise<{ name: string; url: string }> {
    try {
      return await this.request<{ name: string; url: string }>("GET", `/sites/${siteId}/channels/${channelId}`);
    } catch (err) {
      if (!(err instanceof FirebaseHostingError) || err.status !== 404) throw err;
    }
    return this.request<{ name: string; url: string }>("POST", `/sites/${siteId}/channels?channelId=${encodeURIComponent(channelId)}`, { ttl: `${ttlSeconds}s` });
  }

  async release(siteId: string, channelId: string, versionName: string, message?: string): Promise<HostingReleaseResult> {
    const channel = channelId === "live" ? { url: `https://${siteId}.web.app` } : await this.request<{ url: string }>("GET", `/sites/${siteId}/channels/${channelId}`);
    const release = await this.request<{ name: string }>(
      "POST",
      `/sites/${siteId}/channels/${channelId}/releases?versionName=${encodeURIComponent(versionName)}`,
      message ? { message } : {},
    );
    return { releaseName: release.name, url: channel.url };
  }
}

/** Site ids: 6-30 chars, lowercase letters/digits/hyphens, no leading/trailing hyphen. Globally unique across Firebase, hence the prefix. */
export function hostingSiteId(prefix: string, clientSlug: string): string {
  const raw = `${prefix}${clientSlug}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const padded = raw.length < 6 ? `${raw}-site` : raw;
  return padded.slice(0, 30).replace(/-$/, "");
}

/** Channel ids share the site-id alphabet; a run id like `pubsub-20278561164758043` is kept recognisable but shortened. */
export function previewChannelId(runId: string): string {
  const digest = createHash("sha1").update(runId).digest("hex").slice(0, 10);
  return `run-${digest}`;
}

/** ADC-backed token provider using `google-auth-library`, which the server already depends on through `@google-cloud/storage`. */
export async function createAdcTokenProvider(): Promise<TokenProvider> {
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/firebase"] });
  return {
    async getAccessToken() {
      const client = await auth.getClient();
      const token = await client.getAccessToken();
      if (!token.token) throw new Error("google-auth-library returned no access token for Firebase Hosting");
      return token.token;
    },
  };
}
