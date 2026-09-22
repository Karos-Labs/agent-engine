import { Duration } from "@google-cloud/pubsub";
import type { Message, PubSub } from "@google-cloud/pubsub";
import { logError } from "@agent-engine/telemetry";
import { RetryLater, type PublishResult, type QueueAdapter, type QueueMessage, type QueueMessageHandler, type QueueSubscription } from "../types.js";

/** Same client-resolver-function convention `GeminiAdapter`/`OpenAICompatibleAdapter` use — lets a caller memoize one client (the common case) or hand back a per-call/test double, without this class caring which. */
export type PubSubClientResolver = () => PubSub;

/**
 * How many run-jobs one consumer process will hold at once, and how long it
 * will keep extending their ack deadlines.
 *
 * This is not a tuning knob; it is a bound that was missing. The Node client's
 * default `flowControl.maxMessages` is 1000, and this repo's consumer is a
 * PULL worker (`apps/agent-server/dist/queue-consumer.js`, `minScale=1`,
 * 1 vCPU / 2 GiB per instance). One message is one whole workflow run started
 * inline — model calls, rendered plates, and the in-process `.media-cache`
 * holding every downloaded image for the life of the run. A thousand of them
 * on one 2 GiB instance is not a slow instance, it is an OOM, and the
 * redelivery lands on an instance in exactly the same shape.
 *
 * Cloud Run cannot save it either: a pull consumer scales on CPU, not on
 * subscription backlog, so the instance that swallowed the burst is the one
 * that dies with it.
 */
/**
 * How many run-jobs one consumer process holds at once, when nothing says
 * otherwise. FOUR, not the client's 1000 — see `PubSubFlowControlOptions`.
 *
 * The default lives on the ADAPTER rather than only in
 * `createQueueFromEnv`, so that constructing this class directly (a test, a
 * script, a future second entry point) cannot quietly inherit the unbounded
 * one. The env reader imports this constant rather than restating it.
 */
export const DEFAULT_MAX_CONCURRENT_MESSAGES = 4;

/** An agent run can legitimately hold a message for a long time; 60 minutes is the client's own default, restated here so it is a decision rather than an inheritance. */
export const DEFAULT_MAX_ACK_EXTENSION_MINUTES = 60;

export interface PubSubFlowControlOptions {
  /** Messages in flight per process. Small on purpose — the fleet scales by adding INSTANCES (`maxScale`), not by piling runs onto one. */
  maxMessages?: number;
  /**
   * How long the client keeps extending a message's ack deadline before giving
   * up on it. A long agent run legitimately holds one for a while; past this
   * the message is redelivered and the run lease decides what happens next.
   */
  maxExtensionMinutes?: number;
}

export interface GooglePubSubAdapterOptions {
  client: PubSub | PubSubClientResolver;
  flowControl?: PubSubFlowControlOptions;
}

/**
 * The `QueueAdapter` for Google Cloud Pub/Sub. Construction (the real
 * `new PubSub(...)`, which resolves Application Default Credentials) happens
 * only in `create-queue-from-env.ts` — this class only ever receives an
 * already-built client, exactly like every model adapter in
 * `router/adapters/` receives an already-built SDK client rather than
 * constructing one itself.
 */
export class GooglePubSubQueueAdapter implements QueueAdapter {
  readonly providerId = "google-pubsub";
  private readonly resolveClient: PubSubClientResolver;
  private readonly flowControl: PubSubFlowControlOptions;

  constructor(options: GooglePubSubAdapterOptions) {
    this.resolveClient = typeof options.client === "function" ? options.client : () => options.client as PubSub;
    this.flowControl = options.flowControl ?? {};
  }

  async publish(topic: string, payload: unknown, attributes?: Record<string, string>): Promise<PublishResult> {
    const client = this.resolveClient();
    const json = payload as object;
    const messageId = await client.topic(topic).publishMessage(attributes !== undefined ? { json, attributes } : { json });
    return { messageId };
  }

  subscribe<TPayload = unknown>(subscriptionName: string, handler: QueueMessageHandler<TPayload>): QueueSubscription {
    const client = this.resolveClient();
    // `allowExcessMessages: false` matters as much as the count: left true
    // (the client default) the library delivers whatever the server sends in a
    // batch even once `maxMessages` is reached, which turns the bound into a
    // suggestion.
    const subscription = client.subscription(subscriptionName, {
      flowControl: {
        maxMessages: this.flowControl.maxMessages ?? DEFAULT_MAX_CONCURRENT_MESSAGES,
        allowExcessMessages: false,
      },
      // A `SubscriberOptions` field, not a flow-control one — they read as
      // one setting and the client keeps them apart.
      maxExtensionTime: Duration.from({ minutes: this.flowControl.maxExtensionMinutes ?? DEFAULT_MAX_ACK_EXTENSION_MINUTES }),
    });

    const onMessage = (message: Message): void => {
      // Deliberately not awaited here: `subscription.on("message", ...)` is a
      // fire-and-forget event emitter callback, not something Pub/Sub's own
      // client waits on. Each message's ack/nack is driven entirely from
      // inside this async IIFE instead, so one slow handler never blocks the
      // next message arriving on the same stream.
      void (async () => {
        let queueMessage: QueueMessage<TPayload>;
        try {
          queueMessage = {
            id: message.id,
            payload: JSON.parse(message.data.toString("utf8")) as TPayload,
            attributes: message.attributes,
            publishTime: message.publishTime?.toISOString(),
            deliveryAttempt: message.deliveryAttempt,
          };
        } catch (err) {
          // Not valid JSON at all — no amount of redelivery fixes that, but
          // NACK anyway rather than silently dropping it: the subscription's
          // own max-delivery-attempts + dead-letter-topic config is what's
          // supposed to catch a permanently-bad message, not this adapter
          // deciding on its own that it's unrecoverable.
          logError("google-pubsub: message is not valid JSON — nacking", err, { messageId: message.id, subscriptionName });
          message.nack();
          return;
        }

        try {
          await handler(queueMessage);
          message.ack();
        } catch (err) {
          if (err instanceof RetryLater) {
            // Held, not NACKed: the client's lease manager keeps extending the
            // ack deadline of a message it still holds, so nothing is
            // redelivered during the wait, and the NACK at the end of it brings
            // the message back within the subscription's minimum backoff. One
            // delivery attempt spent per wait, not per ten seconds.
            console.warn(`google-pubsub: handler asked to retry message ${message.id} in ${Math.round(err.delayMs / 1000)}s: ${err.message}`);
            setTimeout(() => message.nack(), err.delayMs);
            return;
          }
          // The catch-all for any handler exception, including one the caller
          // never explicitly logged itself — this IS the "unhandled exception"
          // backstop a worker-failures log-based metric needs to see every
          // nack-worthy failure, not just the ones a handler chose to log.
          logError("google-pubsub: handler failed — nacking for redelivery", err, { messageId: message.id, subscriptionName });
          message.nack();
        }
      })();
    };

    const onError = (err: unknown): void => {
      logError("google-pubsub: subscription reported a stream error", err, { subscriptionName });
    };

    subscription.on("message", onMessage);
    subscription.on("error", onError);

    return {
      async stop() {
        subscription.removeListener("message", onMessage);
        subscription.removeListener("error", onError);
        await subscription.close();
      },
    };
  }
}
