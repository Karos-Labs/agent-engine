import { defineTool, success } from "@agent-engine/tool-common";
import { evaluateDoctrineGate } from "./doctrine-gate.js";
import { DoctrineGateInputSchema, type DoctrineGateInput, type DoctrineGateResult } from "./types.js";

const TOOL_VERSION = "1.0.0";

export function createReputationDoctrineGate() {
  return defineTool<DoctrineGateInput, DoctrineGateResult>({
    name: "reputation.doctrineGate",
    version: TOOL_VERSION,
    inputSchema: DoctrineGateInputSchema,
    async execute(input) {
      return success<DoctrineGateResult>(evaluateDoctrineGate(input));
    },
  });
}
