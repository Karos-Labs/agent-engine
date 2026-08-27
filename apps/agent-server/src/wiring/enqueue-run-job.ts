import { createServerQueueAdapter, runJobsTopicName } from "./queue.js";
import type { EnqueueRunJob } from "../routes/runs.js";

/**
 * Publishes a run-job to the same Pub/Sub topic karosCMO publishes to
 * (AU66 / SCRUM-364).
 *
 * ## Why `/runs/start` hands off instead of executing
 *
 * There is exactly one production execution path and this is not it. karosCMO
 * dispatches by publishing; the only run-jobs subscription is a PULL one
 * consumed by `agent-engine-prep-worker`, which has `--no-cpu-throttling` and
 * `min-instances=1`. `/runs/start` used to run the whole workflow inside one
 * HTTP request on a service with a 300s timeout and CPU throttling ON — which
 * killed Chromium nine minutes after the request had already been severed,
 * twice, reproducibly.
 *
 * Routing every start through the same topic collapses that to one path. The
 * worker is the only thing that executes a run, so the only configuration that
 * has to be right is the worker's.
 *
 * ## The run id
 *
 * `pubsub-${messageId}` is not a convention invented here — it is exactly what
 * `queue-consumer.ts` derives from the message it receives, and what the push
 * route derives too. Returning it means a caller can poll
 * `/runs/:runId/status` with the id it was handed. That 404s until the worker
 * claims the message, which is the honest answer to "has it started".
 */
export function createRunJobPublisher(env: Record<string, string | undefined> = process.env): EnqueueRunJob | undefined {
  let queue: ReturnType<typeof createServerQueueAdapter>;
  try {
    queue = createServerQueueAdapter(env);
  } catch {
    // No queue configurable (no GCP project) — local development. Returning
    // undefined lets the route answer with its own specific message naming the
    // missing variables, rather than failing at boot or, far worse, quietly
    // running the job here and reinstating the trap this ticket removes.
    return undefined;
  }

  const topic = runJobsTopicName(env);
  return async (request) => {
    const { messageId } = await queue.publish(topic, request);
    return { runId: `pubsub-${messageId}` };
  };
}
