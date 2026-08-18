import type { AgentContext } from "@agent-engine/core";
import type { ProcessResult, ProcessRunner } from "../src/process/runner.js";

export const ctx: AgentContext = {
  runId: "run-1",
  clientSlug: "acme",
  productId: "branded-shorts",
  runKind: "setup",
  metadata: {},
};

export function fakeRunner(result: ProcessResult): { runner: ProcessRunner; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: ProcessRunner = async (command, args) => {
    calls.push({ command, args });
    return result;
  };
  return { runner, calls };
}
