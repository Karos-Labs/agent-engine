import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), "utf8");

/**
 * Every process that can execute a run must register a telemetry provider
 * (2026-09-22).
 *
 * `initTelemetry()` was called in `server.ts` and only there. Both deployed
 * workers — `agent-engine-prep-worker` and `agent-engine-prod-worker` — run
 * `queue-consumer.ts`; the HTTP server only serves the API. So no
 * `TracerProvider` and no `MeterProvider` were ever registered in the process
 * that actually executes runs. Every `workflow.run` / `workflow.step.*` /
 * `tool.call.*` / `model.call.*` span from AU42/SCRUM-326 was created against
 * the OTel API's no-op tracer and thrown away, and every counter with it.
 *
 * The measurement that found it: Cloud Monitoring held ZERO metric descriptors
 * matching `workload.googleapis.com/agent_engine*` in either project — which
 * was also the reason an alert on "runs ending degraded" could not be built,
 * since the metric it would read did not exist.
 *
 * Nothing caught it because nothing could: a no-op tracer is the documented,
 * correct behaviour when no provider is registered (RFC-01 §11), so the
 * missing call looked exactly like a healthy local test run. It is asserted
 * structurally here because the failure is one of ABSENCE in an entry point,
 * and an entry point's `main()` is not callable from a test without starting
 * a real Pub/Sub subscription.
 */
const ENTRY_POINTS = ["apps/agent-server/src/server.ts", "apps/agent-server/src/queue-consumer.ts"] as const;

describe("telemetry is initialised by every entry point, not just the HTTP one", () => {
  it.each(ENTRY_POINTS)("%s awaits initTelemetry()", (file) => {
    const source = read(file);
    expect(source).toMatch(/await initTelemetry\(\)/);
    expect(source).toMatch(/import \{[^}]*\binitTelemetry\b[^}]*\} from "@agent-engine\/telemetry"/);
  });

  it.each(ENTRY_POINTS)("%s flushes on shutdown, so the last spans are not lost in the batch buffer", (file) => {
    // `BatchSpanProcessor` buffers for ~5s. The spans of whatever the process
    // was doing when it was told to stop are disproportionately the ones worth
    // having, and without an explicit shutdown they die in the buffer.
    expect(read(file)).toMatch(/shutdownTelemetry\(\)/);
  });

  it("names every entry point this repo ships, so a new one cannot quietly skip the check", () => {
    // The guard is only as good as its list. `package.json`'s `start:*`
    // scripts are what a container actually runs, so they are the list.
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    const started = Object.entries(scripts)
      .filter(([name]) => name.startsWith("start:"))
      .map(([, command]) => command);
    expect(started.length).toBeGreaterThan(0);

    for (const command of started) {
      const dist = /apps\/agent-server\/dist\/([\w-]+)\.js/.exec(command);
      expect(dist, `no dist entry point found in start script: ${command}`).not.toBeNull();
      expect(ENTRY_POINTS).toContain(`apps/agent-server/src/${dist?.[1] ?? ""}.ts`);
    }
  });
});
