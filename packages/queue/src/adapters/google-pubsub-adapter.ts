import type { Message, PubSub } from "@google-cloud/pubsub";
import type { PublishResult, QueueAdapter, QueueMessage, QueueMessageHandler, QueueSubscription } from "../types.js";

/** Same client-resolver-function convention `GeminiAdapter`/`OpenAICompatibleAdapter` use — lets a caller memoize one client (the common case) or hand back a per-call/test double, without this class caring which. */
export type PubSubClientResolver = () => PubSub;

export interface GooglePubSubAdapterOptions {
  client: PubSub | PubSubClientResolver;
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

  constructor(options: GooglePubSubAdapterOptions) {
    this.resolveClient = typeof options.client === "function" ? options.client : () => options.client as PubSub;
  }

  async publish(topic: string, payload: unknown, attributes?: Record<string, string>): Promise<PublishResult> {
    const client = this.resolveClient();
    const json = payload as object;
    const messageId = await client.topic(topic).publishMessage(attributes !== undefined ? { json, attributes } : { json });
    return { messageId };
  }

  subscribe<TPayload = unknown>(subscriptionName: string, handler: QueueMessageHandler<TPayload>): QueueSubscription {
    const client = this.resolveClient();
    const subscription = client.subscription(subscriptionName);

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
          console.error(`google-pubsub: message ${message.id} on "${subscriptionName}" is not valid JSON — nacking`, err);
          message.nack();
          return;
        }

        try {
          await handler(queueMessage);
          message.ack();
        } catch (err) {
          console.error(`google-pubsub: handler failed for message ${message.id} on "${subscriptionName}" — nacking for redelivery`, err);
          message.nack();
        }
      })();
    };

    const onError = (err: unknown): void => {
      console.error(`google-pubsub: subscription "${subscriptionName}" reported a stream error`, err);
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
