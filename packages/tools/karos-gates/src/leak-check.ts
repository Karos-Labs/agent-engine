import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

/** Credential- and secret-shaped patterns that should never appear in client-facing output. */
const BUILTIN_LEAK_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "Anthropic/OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "PEM private key block", pattern: /-----BEGIN(?: RSA)? PRIVATE KEY-----/ },
  { label: "local filesystem path", pattern: /(?:[A-Za-z]:\\|\/(?:Users|home)\/)\S+/ },
  { label: ".env file reference", pattern: /\.env\b/i },
];

export const LeakCheckInputSchema = z.object({
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from the tool's own doc comment.
  text: z.string().describe("The draft text to scan for leaked credentials, local file paths, or client-specific internal terms."),
  extraTerms: z
    .array(z.string())
    .default([])
    .describe("Additional client-specific internal terms (codenames, etc), matched case-insensitively as literal substrings."),
});
export type LeakCheckInput = z.infer<typeof LeakCheckInputSchema>;

/** Fails if the draft looks like it leaked a credential, a local file path, or a client-specific internal term. */
export const leakCheck = defineTool<LeakCheckInput, GateVerdict>({
  name: "gate.leakCheck",
  description: "Fails if the draft looks like it leaked a credential, a local file path, or a client-specific internal term.",
  version: TOOL_VERSION,
  inputSchema: LeakCheckInputSchema,
  async execute({ text, extraTerms }) {
    const evidence: string[] = [];

    for (const { label, pattern } of BUILTIN_LEAK_PATTERNS) {
      const match = pattern.exec(text);
      if (match) {
        evidence.push(`${label}: "${match[0]}"`);
      }
    }

    const lower = text.toLowerCase();
    for (const term of extraTerms) {
      if (term.length > 0 && lower.includes(term.toLowerCase())) {
        evidence.push(`internal term: "${term}"`);
      }
    }

    if (evidence.length > 0) {
      return success<GateVerdict>({
        verdict: "content_fail",
        evidence,
        reason: "text appears to leak a credential, local path, or internal-only term",
        toolVersion: TOOL_VERSION,
      });
    }

    return success<GateVerdict>({ verdict: "pass", evidence: ["no leak patterns matched"], toolVersion: TOOL_VERSION });
  },
});
