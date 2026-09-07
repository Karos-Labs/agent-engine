import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolUnitUsage } from "./tool.js";

/**
 * Attributes a tool's per-unit usage (Veo seconds, TTS characters, QA
 * tokens, generated images) to the workflow step that is running when the
 * tool is called — whatever that step's body chooses to return.
 *
 * Before this (2026-09-08) a step was billed for a tool's units only if its
 * body RETURNED the tool's outcome, because `runStepCode` read usage off the
 * return value and nothing else. Most media steps do not return outcomes:
 * `04p-plate-N` returns a file path, `05-voiceover` a `{path, words}` object,
 * `10b-visual-qa` a verdict — so a TikTok original short that generated five
 * Veo plates, a voiceover and a video QA pass reported $0.13, the token cost
 * of its two text steps, against ~$13 of media it actually bought. The same
 * hole applied to every tool an agent called inside its ReAct loop.
 *
 * `AsyncLocalStorage` rather than a parameter so no call site changes: a
 * step primitive opens a scope around the body, `defineTool` records into
 * whichever scope is active, and a tool with nothing to report records
 * nothing. Nested scopes (a step inside a step) are independent — the inner
 * step owns its usage, the outer does not see it again.
 */
const activeSink = new AsyncLocalStorage<ToolUnitUsage[]>();

/** Runs `fn` with `sink` as the active usage collector; entries recorded during it are pushed onto `sink`. */
export function runInToolUsageScope<T>(sink: ToolUnitUsage[], fn: () => T | Promise<T>): Promise<T> {
  return activeSink.run(sink, async () => fn());
}

/**
 * Records usage against the active scope. A no-op outside one, by design: a
 * tool called from a test, a script, or a code path no step owns has nobody
 * to bill and must not throw over it.
 */
export function recordToolUsage(usage: readonly ToolUnitUsage[]): void {
  const sink = activeSink.getStore();
  if (sink === undefined) return;
  for (const entry of usage) sink.push(entry);
}
