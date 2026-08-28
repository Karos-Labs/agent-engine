import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

/** Case-insensitive substrings that mean a draft still has an unresolved placeholder in it. */
const PLACEHOLDER_MARKERS = ["{{", "}}", "[insert", "[placeholder]", "<placeholder>", "todo:", "fixme", "lorem ipsum"];

export const NoPlaceholderInputSchema = z.object({
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from the tool's own doc comment.
  text: z.string().describe("The draft text to check for unresolved template placeholder markers."),
});
export type NoPlaceholderInput = z.infer<typeof NoPlaceholderInputSchema>;

/** Fails if the draft still contains a template placeholder marker nobody filled in. */
export const noPlaceholder = defineTool<NoPlaceholderInput, GateVerdict>({
  name: "gate.noPlaceholder",
  description: "Fails if the draft still contains a template placeholder marker nobody filled in.",
  version: TOOL_VERSION,
  inputSchema: NoPlaceholderInputSchema,
  async execute({ text }) {
    const lower = text.toLowerCase();
    const found = PLACEHOLDER_MARKERS.filter((marker) => lower.includes(marker));

    if (found.length > 0) {
      return success<GateVerdict>({
        verdict: "content_fail",
        evidence: found,
        reason: `text contains an unresolved placeholder marker: ${found.join(", ")}`,
        toolVersion: TOOL_VERSION,
      });
    }

    return success<GateVerdict>({ verdict: "pass", evidence: ["no placeholder markers found"], toolVersion: TOOL_VERSION });
  },
});
