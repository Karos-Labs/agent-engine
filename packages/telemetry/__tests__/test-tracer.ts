import { trace, type Context } from "@opentelemetry/api";
import { NodeTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

/**
 * Registers a REAL `TracerProvider` (an in-memory exporter, plus an
 * `AsyncLocalStorageContextManager` so a span opened before an `await`
 * correctly stays the parent of one opened after it) for the life of one
 * test file — the same context-propagation mechanism `initTelemetry()` wires
 * up for production (`NodeSDK` registers an ALS-backed context manager by
 * default), exercised here without any network/GCP dependency.
 *
 * Every test in `packages/telemetry/__tests__/span-helpers.test.ts` up to
 * this point ran against the OTel API's own no-op tracer (no `TracerProvider`
 * registered at all) — correct for proving the no-op path is safe, but
 * incapable of proving anything about what a span actually RECORDS (status,
 * attributes, parent/child nesting). This is what lets AU42/SCRUM-326's tests
 * assert on real span data instead.
 */
export interface TestTracing {
  exporter: InMemorySpanExporter;
  /** All spans exported so far, oldest first. */
  finishedSpans(): ReadableSpan[];
  /** Clears recorded spans between assertions within one test, without re-registering the provider. */
  reset(): void;
  /** Unregisters everything this set up — call in `afterEach`/`afterAll`. */
  shutdown(): Promise<void>;
}

export function setupTestTracing(): TestTracing {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  provider.register({ contextManager });

  return {
    exporter,
    finishedSpans: () => exporter.getFinishedSpans(),
    reset: () => exporter.reset(),
    async shutdown() {
      contextManager.disable();
      trace.disable();
      await provider.shutdown();
    },
  };
}

/** Finds one exported span by exact name — fails loudly (returns `undefined`) rather than guessing, so a missing span is a clear assertion failure, not a silent `[0]`. */
export function findSpan(spans: readonly ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((s) => s.name === name);
}

/** Whether `child` is a direct child of `parent` in the exported span tree. */
export function isChildOf(child: ReadableSpan, parent: ReadableSpan): boolean {
  return child.parentSpanContext?.spanId === parent.spanContext().spanId;
}

export type { Context };
