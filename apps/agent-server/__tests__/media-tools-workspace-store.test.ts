import { describe, expect, it } from "vitest";
import type { WorkspaceStoreLike } from "@agent-engine/tools";
import { createServerTools } from "../src/wiring/tools.js";

/**
 * 2026-09-24: `createKarosMediaTools` was called without `store`, so the
 * media library, the likeness-consent record and the visual-pattern profile
 * all read and wrote a LOCAL `.karos-workspace` under the container's cwd.
 * In prep that directory is not writable (`EACCES ... mkdir
 * '/app/.karos-workspace'`), so no client picture was ever filed. The server's
 * workspace handle is the one they must use.
 */
describe("the media tools use the server's workspace store", () => {
  it("media.libraryList reads the client's library through the injected store, not a local directory", async () => {
    const reads: Array<{ clientSlug: string; segments: readonly string[] }> = [];
    const store: WorkspaceStoreLike = {
      exists: async () => false,
      readJson: async <T,>(clientSlug: string, segments: readonly string[]) => {
        reads.push({ clientSlug, segments });
        return undefined as T | undefined;
      },
      writeJson: async () => ({ committed: true }) as never,
      listJson: async () => [],
    };
    const tools = createServerTools(store, {});
    const outcome = await tools["media.libraryList"]!.execute({}, { ctx: { runId: "r", clientSlug: "hankypanky", productId: "instagram-agent", runKind: "recurring", metadata: {} } });
    expect(outcome.status).toBe("success");
    expect(reads).toContainEqual({ clientSlug: "hankypanky", segments: ["client", "media-library"] });
  });
});
