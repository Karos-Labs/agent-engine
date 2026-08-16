import { describeError } from "./errors.js";
import type { PromptStore } from "./prompt-store.js";
import type { VertexAIPromptClient } from "./gcp-types.js";

/** Five minutes — long enough that a multi-step workflow run resolving the same `skillRef` repeatedly doesn't refetch on every step, short enough that a published prompt edit shows up well within a single work session. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface VertexAIPromptStoreOptions {
  /** How long a resolved prompt stays cached in memory before the next call refetches it. Default 5 minutes. */
  ttlMs?: number;
  /**
   * A second `PromptStore` to fall back to when the Vertex AI client call
   * fails (offline, API disabled, quota, transient error) — typically a
   * `FirestorePromptStore` or a `FilePromptStore` pointed at the same
   * content checked into the repo. Optional: with no fallback configured, a
   * client failure just propagates as-is.
   */
  fallback?: PromptStore;
  /** Injectable clock, for deterministic cache-expiry tests. Defaults to `Date.now`. */
  now?: () => number;
}

interface CacheEntry {
  content: string;
  expiresAt: number;
}

/**
 * A `PromptStore` backed by Vertex AI's prompt-management surface (RFC-01
 * §16.1) via an injected `VertexAIPromptClient` — see `./gcp-types.ts` for
 * why that client shape is deliberately minimal rather than a wrapper around
 * a specific SDK class. Adds the two things a raw per-call API fetch
 * wouldn't have on its own:
 *
 * - An in-memory TTL cache, keyed by `promptId@version` (`"latest"` when no
 *   version is given) — a workflow run that resolves the same `skillRef` on
 *   every one of several steps shouldn't turn into that many live API calls.
 * - A graceful fallback: if the Vertex AI call throws, and a `fallback`
 *   store was configured, this resolves from there instead of failing the
 *   whole step outright.
 */
export class VertexAIPromptStore implements PromptStore {
  private readonly ttlMs: number;
  private readonly fallback: PromptStore | undefined;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly client: VertexAIPromptClient,
    options: VertexAIPromptStoreOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.fallback = options.fallback;
    this.now = options.now ?? Date.now;
  }

  async getPrompt(promptId: string, version?: string): Promise<string> {
    const cacheKey = `${promptId}@${version ?? "latest"}`;
    const cached = this.cache.get(cacheKey);
    if (cached && this.now() < cached.expiresAt) {
      return cached.content;
    }

    try {
      const content = await this.client.getPromptVersion(promptId, version);
      this.cache.set(cacheKey, { content, expiresAt: this.now() + this.ttlMs });
      return content;
    } catch (err) {
      if (!this.fallback) {
        throw err;
      }
      try {
        const content = await this.fallback.getPrompt(promptId, version);
        // Cache the fallback's result too — during an outage, this is what stops
        // every subsequent call in the same run from hitting the failing Vertex
        // AI client again before the TTL window closes.
        this.cache.set(cacheKey, { content, expiresAt: this.now() + this.ttlMs });
        return content;
      } catch (fallbackErr) {
        throw new Error(
          `VertexAIPromptStore: both the Vertex AI client and the configured fallback failed for "${cacheKey}" ` +
            `(vertex: ${describeError(err)}; fallback: ${describeError(fallbackErr)})`,
          { cause: err },
        );
      }
    }
  }
}
