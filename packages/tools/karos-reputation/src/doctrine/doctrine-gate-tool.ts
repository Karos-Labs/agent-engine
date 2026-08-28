import { defineTool, success } from "@agent-engine/tool-common";
import { evaluateDoctrineGate } from "./doctrine-gate.js";
import { DoctrineGateInputSchema, type DoctrineGateInput, type DoctrineGateResult } from "./types.js";

const TOOL_VERSION = "1.0.0";

export function createReputationDoctrineGate() {
  return defineTool<DoctrineGateInput, DoctrineGateResult>({
    name: "reputation.doctrineGate",
    description:
      "Validates a separate model pass's four doctrine verdicts (no fault concession, no blame, no financial promises, facts grounded) against a drafted review response, computing the overall gate decision and running independent mechanical backstop checks that can override a model's own \"pass\".",
    version: TOOL_VERSION,
    inputSchema: DoctrineGateInputSchema,
    async execute(input) {
      return success<DoctrineGateResult>(evaluateDoctrineGate(input));
    },
  });
}
