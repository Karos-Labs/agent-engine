import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { NodeTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { getTracer } from "@agent-engine/telemetry";
import { createApp } from "../src/app.js";
import { setupTestEnvironment, type TestEnvironment, inProcessEnqueue } from "./test-helpers.js";

/**
 * AU42/SCRUM-326: the "HTTP request" leg of "a full trace from HTTP request →
 * run → steps → tool calls → model calls" — exercised here through the REAL
 * `createApp()` and a real HTTP request via `supertest`, not a mocked
 * req/res (see `httpTracingMiddleware`/`withHttpRequestSpan`'s own unit tests
 * in `packages/telemetry` for that half).
 */
describe("HTTP request tracing, mounted for real in createApp()", () => {
  let env: TestEnvironment;
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let contextManager: AsyncLocalStorageContextManager;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    provider.register({ contextManager });
  });

  afterEach(async () => {
    await env.cleanup();
    contextManager.disable();
    trace.disable();
    await provider.shutdown();
  });

  it("records an HTTP span for a real GET /healthz request, with method/route/status attributes", async () => {
    const app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps, enqueueRunJob: inProcessEnqueue(env) });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);

    const spans: ReadableSpan[] = exporter.getFinishedSpans();
    const httpSpan = spans.find((s) => s.name === "HTTP GET");
    expect(httpSpan, "expected an HTTP request span from the real mounted middleware").toBeDefined();
    expect(httpSpan!.attributes["http.method"]).toBe("GET");
    expect(httpSpan!.attributes["http.route"]).toBe("/healthz");
    expect(httpSpan!.attributes["http.status_code"]).toBe(200);
    expect(httpSpan!.status.code).toBe(SpanStatusCode.OK);
  });

  it("a span opened by a route handler (mid dispatch) nests under the real HTTP span — proves context propagates through Express's actual middleware chain, not just a mock", async () => {
    // `createHealthRouter` is fixed, so this reaches into the real dispatch
    // through the app's authenticated diagnostics route instead — no `auth`
    // configured here means it's reachable without a token (see `app.ts`'s own
    // "AU1: unset auth disables the check" contract), and its handler runs a
    // moment after the HTTP middleware, exactly the "does context survive
    // Express's real async dispatch" question this test exists to answer.
    const app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps, enqueueRunJob: inProcessEnqueue(env) });
    app.get("/__test-nested-span", (_req, res) => {
      const tracer = getTracer();
      tracer.startActiveSpan("inner-handler-span", (span) => {
        span.end();
        res.status(200).json({ ok: true });
      });
    });

    const res = await request(app).get("/__test-nested-span");
    expect(res.status).toBe(200);

    const spans: ReadableSpan[] = exporter.getFinishedSpans();
    const httpSpan = spans.find((s) => s.name === "HTTP GET");
    const innerSpan = spans.find((s) => s.name === "inner-handler-span");
    expect(httpSpan).toBeDefined();
    expect(innerSpan).toBeDefined();
    expect(innerSpan!.parentSpanContext?.spanId, "the handler's span must be a child of the request span — same trace, real Express dispatch").toBe(
      httpSpan!.spanContext().spanId,
    );
    expect(innerSpan!.spanContext().traceId).toBe(httpSpan!.spanContext().traceId);
  });
});
