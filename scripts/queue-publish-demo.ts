/**
 * Publishes ONE real run-job message to the configured Pub/Sub topic, to
 * prove "publish a message -> a job actually runs" end to end against
 * whichever consumer you have listening:
 *
 *   - `npm run dev:queue-consumer --workspace=@agent-engine/agent-server`
 *     (pull-based, for local testing — no public URL needed), or
 *   - a real push subscription pointed at a deployed server's
 *     `/api/v1/queue/pubsub-push`.
 *
 * This does NOT run a job itself — it only publishes. Whichever consumer is
 * listening does the rest, exactly like a real caller (karosCMO/Portal, or
 * anything else) would.
 *
 * Run with:
 *   npx tsx --env-file=.env scripts/queue-publish-demo.ts
 *   npx tsx --env-file=.env scripts/queue-publish-demo.ts linkedin-agent acme
 */
import { createQueueFromEnv } from "@agent-engine/queue";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";

function readEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

function topicName(): string {
  return readEnv("QUEUE_TOPIC_RUN_JOBS") ?? "agent-engine-run-jobs";
}

async function main(): Promise<void> {
  const productId = process.argv[2] ?? "linkedin-agent";
  const clientSlug = process.argv[3] ?? "acme";
  const runKind = "recurring";

  const queue = createQueueFromEnv();
  const topic = topicName();
  const payload = { clientSlug, productId, runKind };

  console.log(`${DIM}publishing to topic "${topic}" via ${queue.providerId}...${RESET}`);
  console.log(`${DIM}payload: ${JSON.stringify(payload)}${RESET}`);

  const result = await queue.publish(topic, payload);

  console.log();
  console.log(`${BOLD}${GREEN}published${RESET} — messageId: ${result.messageId}`);
  console.log(`${DIM}a listening consumer will run this as runId "pubsub-${result.messageId}".${RESET}`);
}

main().catch((err) => {
  console.error("failed to publish", err);
  process.exit(1);
});
