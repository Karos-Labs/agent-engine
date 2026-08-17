import type { AgentToolRegistry } from "@agent-engine/core";
import { createWorkspaceStore, type WorkspaceStoreLike } from "@agent-engine/tool-common";
import { createGetProfile } from "./get-profile.js";
import { createGetBrand } from "./get-brand.js";
import { createGetVoiceRules } from "./get-voice-rules.js";
import { createListCompetitors } from "./list-competitors.js";
import { createGetExecutives } from "./get-executives.js";
import { createGetConfig } from "./get-config.js";
import { createGetSubredditRules } from "./get-subreddit-rules.js";

export * from "./get-profile.js";
export * from "./get-brand.js";
export * from "./get-voice-rules.js";
export * from "./list-competitors.js";
export * from "./get-executives.js";
export * from "./get-config.js";
export * from "./get-subreddit-rules.js";

/**
 * The `karos-client` MCP server's tool registry (RFC-01 §9.1/§9.2) — a
 * read-only, tenant-bound view of a client's onboarding data. Every tool
 * resolves its tenant from `context.ctx.clientSlug`; none accepts a
 * tenant-shaped argument.
 */
export function createKarosClientTools(store: WorkspaceStoreLike = createWorkspaceStore()): AgentToolRegistry {
  return {
    "client.getProfile": createGetProfile(store),
    "client.getBrand": createGetBrand(store),
    "client.getVoiceRules": createGetVoiceRules(store),
    "client.listCompetitors": createListCompetitors(store),
    "client.getExecutives": createGetExecutives(store),
    "client.getConfig": createGetConfig(store),
    "client.getSubredditRules": createGetSubredditRules(store),
  };
}
