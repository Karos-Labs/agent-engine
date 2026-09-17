import { describe, expect, it } from "vitest";
import type { GraphRuntime } from "../src/graph-client.js";
import { createKarosMetaTools } from "../src/index.js";
import { createInstagramMediaContainer, publishInstagramImagePost, publishInstagramMediaContainer, waitForContainerReady } from "../src/publish.js";

const SYSTEM_USER_TOKEN = "EAAtest-system-user-token";
const IG_USER_ID = "17841400000000000";
const IMAGE_URL = "https://cdn.example.com/photo.jpg";

interface RecordedCall {
  method: string;
  url: URL;
  body?: string;
}

interface MockOptions {
  statusFor?: Record<string, number>;
  errorBodyFor?: Record<string, { code?: number; error_subcode?: number; message?: string }>;
  /** Overrides the container's status_code sequence for successive polls (defaults to immediately FINISHED). */
  containerStatusSequence?: string[];
}

function metaApiMock(options: MockOptions = {}): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let pollCount = 0;

  const json = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

  const classify = (method: string, url: URL): string => {
    if (method === "POST" && url.pathname === `/v20.0/${IG_USER_ID}/media`) return "createContainer";
    if (method === "POST" && url.pathname === `/v20.0/${IG_USER_ID}/media_publish`) return "publishContainer";
    if (method === "GET" && url.pathname === "/v20.0/container-123") return "pollContainer";
    if (method === "GET" && url.pathname === "/v20.0/published-media-456") return "fetchPermalink";
    if (method === "GET" && url.pathname === `/v20.0/${IG_USER_ID}`) return "followerCount";
    return `unrouted:${method}:${url.pathname}`;
  };

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, url, ...(body ? { body } : {}) });
    const routeId = classify(method, url);

    const status = options.statusFor?.[routeId];
    if (status !== undefined && status !== 200) {
      const errBody = options.errorBodyFor?.[routeId] ?? { message: `injected ${status}` };
      return json({ error: errBody }, status);
    }

    switch (routeId) {
      case "createContainer":
        return json({ id: "container-123" });
      case "publishContainer":
        return json({ id: "published-media-456" });
      case "pollContainer": {
        const sequence = options.containerStatusSequence ?? ["FINISHED"];
        const statusCode = sequence[Math.min(pollCount, sequence.length - 1)];
        pollCount += 1;
        return json({ status_code: statusCode });
      }
      case "fetchPermalink":
        return json({ permalink: "https://www.instagram.com/p/abc123/" });
      case "followerCount":
        return json({ followers_count: 12_345 });
      default:
        return json({ error: { message: `unrouted ${method} ${url.pathname}` } }, 404);
    }
  }) as typeof fetch;

  return { fetchImpl, calls };
}

function runtimeFor(fetchImpl: typeof fetch, sleep?: (ms: number) => Promise<void>): GraphRuntime {
  return {
    fetchImpl,
    policy: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoffFactor: 1, retryableStatuses: [], maxRetryAfterMs: 0 },
    ...(sleep ? { sleep } : {}),
  };
}

const noSleep = async () => {};

describe("createInstagramMediaContainer", () => {
  it("POSTs image_url and caption as a form-encoded body, never the query string", async () => {
    const { fetchImpl, calls } = metaApiMock();
    const outcome = await createInstagramMediaContainer(SYSTEM_USER_TOKEN, IG_USER_ID, { imageUrl: IMAGE_URL, caption: "Hello" }, runtimeFor(fetchImpl));
    expect(outcome).toEqual({ method: "createInstagramMediaContainer", status: "ok", payload: "container-123", attempts: 1 });
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.searchParams.get("image_url")).toBeNull(); // must not leak into the query string
    const body = new URLSearchParams(call.body);
    expect(body.get("image_url")).toBe(IMAGE_URL);
    expect(body.get("caption")).toBe("Hello");
    expect(body.get("access_token")).toBe(SYSTEM_USER_TOKEN);
  });

  it("reports a dead-token hint on a 190 without posting anything else", async () => {
    const { fetchImpl } = metaApiMock({
      statusFor: { createContainer: 401 },
      errorBodyFor: { createContainer: { code: 190, message: "Error validating access token" } },
    });
    const outcome = await createInstagramMediaContainer(SYSTEM_USER_TOKEN, IG_USER_ID, { imageUrl: IMAGE_URL }, runtimeFor(fetchImpl));
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toContain("dead or was revoked");
  });

  it("reports an App Review hint on Meta's permission-pending shape (instagram_content_publish not yet approved)", async () => {
    const { fetchImpl } = metaApiMock({
      statusFor: { createContainer: 403 },
      errorBodyFor: { createContainer: { code: 10, message: "Application does not have permission for this action" } },
    });
    const outcome = await createInstagramMediaContainer(SYSTEM_USER_TOKEN, IG_USER_ID, { imageUrl: IMAGE_URL }, runtimeFor(fetchImpl));
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toContain("has not cleared Meta App Review yet");
  });
});

describe("waitForContainerReady", () => {
  it("returns FINISHED immediately when the first poll already says so", async () => {
    const { fetchImpl, calls } = metaApiMock({ containerStatusSequence: ["FINISHED"] });
    const outcome = await waitForContainerReady(SYSTEM_USER_TOKEN, "container-123", runtimeFor(fetchImpl), { sleep: noSleep });
    expect(outcome).toEqual({ method: "waitForContainerReady", status: "ok", payload: "FINISHED", attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  it("polls through IN_PROGRESS until FINISHED", async () => {
    const { fetchImpl, calls } = metaApiMock({ containerStatusSequence: ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"] });
    const outcome = await waitForContainerReady(SYSTEM_USER_TOKEN, "container-123", runtimeFor(fetchImpl), { sleep: noSleep, delayMs: 0 });
    expect(outcome.status).toBe("ok");
    expect(outcome.payload).toBe("FINISHED");
    expect(calls).toHaveLength(3);
  });

  it("reports UNAVAILABLE, not a thrown error, when Meta reports the container as ERROR", async () => {
    const { fetchImpl } = metaApiMock({ containerStatusSequence: ["ERROR"] });
    const outcome = await waitForContainerReady(SYSTEM_USER_TOKEN, "container-123", runtimeFor(fetchImpl), { sleep: noSleep });
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toContain("ERROR");
  });

  it("gives up after maxAttempts rather than polling forever", async () => {
    const { fetchImpl, calls } = metaApiMock({ containerStatusSequence: ["IN_PROGRESS"] });
    const outcome = await waitForContainerReady(SYSTEM_USER_TOKEN, "container-123", runtimeFor(fetchImpl), { sleep: noSleep, delayMs: 0, maxAttempts: 3 });
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toContain("did not reach FINISHED");
    expect(calls).toHaveLength(3);
  });
});

describe("publishInstagramMediaContainer", () => {
  it("POSTs the creation_id to media_publish", async () => {
    const { fetchImpl, calls } = metaApiMock();
    const outcome = await publishInstagramMediaContainer(SYSTEM_USER_TOKEN, IG_USER_ID, "container-123", runtimeFor(fetchImpl));
    expect(outcome).toEqual({ method: "publishInstagramMediaContainer", status: "ok", payload: "published-media-456", attempts: 1 });
    const body = new URLSearchParams(calls[0]!.body);
    expect(body.get("creation_id")).toBe("container-123");
  });
});

describe("publishInstagramImagePost (full orchestration)", () => {
  it("creates the container, waits for it, publishes it, and fetches the permalink", async () => {
    const { fetchImpl, calls } = metaApiMock();
    const outcome = await publishInstagramImagePost(SYSTEM_USER_TOKEN, IG_USER_ID, { imageUrl: IMAGE_URL, caption: "New drop" }, runtimeFor(fetchImpl, noSleep));
    expect(outcome.status).toBe("ok");
    expect(outcome.payload).toEqual({ mediaId: "published-media-456", permalink: "https://www.instagram.com/p/abc123/" });
    expect(calls.map((c) => c.method + " " + c.url.pathname)).toEqual([
      `POST /v20.0/${IG_USER_ID}/media`,
      "GET /v20.0/container-123",
      `POST /v20.0/${IG_USER_ID}/media_publish`,
      "GET /v20.0/published-media-456",
    ]);
  });

  it("stops at container creation and never calls media_publish when the container fails", async () => {
    const { fetchImpl, calls } = metaApiMock({
      statusFor: { createContainer: 400 },
      errorBodyFor: { createContainer: { message: "Invalid image_url" } },
    });
    const outcome = await publishInstagramImagePost(SYSTEM_USER_TOKEN, IG_USER_ID, { imageUrl: "not-a-real-url" }, runtimeFor(fetchImpl, noSleep));
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(calls).toHaveLength(1); // never reached media_publish
  });

  it("degrades to no permalink, without failing the whole publish, when the permalink lookup fails", async () => {
    const { fetchImpl } = metaApiMock({ statusFor: { fetchPermalink: 500 } });
    const outcome = await publishInstagramImagePost(SYSTEM_USER_TOKEN, IG_USER_ID, { imageUrl: IMAGE_URL }, runtimeFor(fetchImpl, noSleep));
    expect(outcome.status).toBe("ok");
    expect(outcome.payload).toEqual({ mediaId: "published-media-456" });
  });
});

describe("createKarosMetaTools — meta.publishInstagramPost gating", () => {
  function contextFor() {
    return { ctx: { runId: "test-run", clientSlug: "test-client", productId: "test-product" } } as Parameters<
      ReturnType<typeof createKarosMetaTools>["meta.publishInstagramPost"]["execute"]
    >[1];
  }

  it("reports not_available with zero network calls when no token is configured, even if META_PUBLISH_ENABLED=1", async () => {
    const { fetchImpl, calls } = metaApiMock();
    const tools = createKarosMetaTools({ env: { META_PUBLISH_ENABLED: "1" }, fetchImpl });
    const outcome = await tools["meta.publishInstagramPost"]!.execute({ igUserId: IG_USER_ID, imageUrl: IMAGE_URL }, contextFor());
    expect(outcome.status).toBe("not_available");
    expect(calls).toHaveLength(0);
  });

  it("reports not_available with zero network calls when a token IS configured but META_PUBLISH_ENABLED is unset — the core safety property", async () => {
    const { fetchImpl, calls } = metaApiMock();
    const tools = createKarosMetaTools({ env: { META_SYSTEM_USER_TOKEN: SYSTEM_USER_TOKEN }, fetchImpl });
    const outcome = await tools["meta.publishInstagramPost"]!.execute({ igUserId: IG_USER_ID, imageUrl: IMAGE_URL }, contextFor());
    expect(outcome.status).toBe("not_available");
    if (outcome.status === "not_available") {
      expect(outcome.reason).toContain("META_PUBLISH_ENABLED");
    }
    expect(calls).toHaveLength(0);
  });

  it("only reaches the Graph API once BOTH the token and META_PUBLISH_ENABLED are set", async () => {
    const { fetchImpl, calls } = metaApiMock();
    const tools = createKarosMetaTools({ env: { META_SYSTEM_USER_TOKEN: SYSTEM_USER_TOKEN, META_PUBLISH_ENABLED: "1" }, fetchImpl });
    const outcome = await tools["meta.publishInstagramPost"]!.execute({ igUserId: IG_USER_ID, imageUrl: IMAGE_URL }, contextFor());
    expect(outcome.status).toBe("success");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("reads reads (meta.fetchFollowerCount) as normal when META_PUBLISH_ENABLED is unset — the publish gate is scoped to the publish tool only", async () => {
    const { fetchImpl, calls } = metaApiMock();
    const tools = createKarosMetaTools({ env: { META_SYSTEM_USER_TOKEN: SYSTEM_USER_TOKEN }, fetchImpl });
    const context = { ctx: { runId: "test-run", clientSlug: "test-client", productId: "test-product" } } as Parameters<
      (typeof tools)["meta.fetchFollowerCount"]["execute"]
    >[1];
    const outcome = await tools["meta.fetchFollowerCount"]!.execute({ igUserId: IG_USER_ID }, context);
    expect(outcome.status).toBe("success");
    expect(calls).toHaveLength(1);
  });
});
