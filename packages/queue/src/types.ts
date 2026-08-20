/**
 * The vendor-agnostic job-queue contract every caller in this codebase
 * depends on. Nothing outside `adapters/` or `create-queue-from-env.ts` may
 * import a queue vendor's SDK directly — the same discipline
 * `router/adapters/types.ts` (`ModelAdapter`) already established for model
 * vendors, applied here to queue vendors. Swapping Google Cloud Pub/Sub for
 * another provider later means writing one new class that implements this
 * interface and one branch in `create-queue-from-env.ts`; every publisher
 * and every consumer in this repo keeps working unchanged.
 */

/** One message as this codebase sees it, independent of the wire vendor. */
export interface QueueMessage<TPayload = unknown> {
  /**
   * The provider's own message id. Stable across *redeliveries of the same
   * unacked message* (Pub/Sub reuses it on retry), which is exactly what
   * makes it safe to derive a deterministic idempotency key from — see
   * `apps/agent-server/src/run-job.ts`'s own doc comment on why that matters
   * for at-least-once delivery.
   */
  id: string;
  /** Already JSON-parsed — callers never touch a raw byte buffer. */
  payload: TPayload;
  attributes: Record<string, string>;
  /** ISO-8601, when the provider reports one. */
  publishTime?: string;
  /** 1 on first delivery, incrementing on each redelivery, when the provider reports one. */
  deliveryAttempt?: number;
}

export interface PublishResult {
  /** The provider's id for the published message — becomes `QueueMessage.id` on the consuming side. */
  messageId: string;
}

/**
 * Returning normally ACKs the message (it will never be redelivered).
 * Throwing NACKs it — the adapter is responsible for catching the throw,
 * logging it, and calling the provider's own nack, never for crashing the
 * consumer process over one bad message. The provider's own subscription
 * config (max delivery attempts + dead-letter topic, for Pub/Sub) decides
 * how many times a NACKed message is retried before it's given up on — this
 * interface deliberately has no dead-letter concept of its own to duplicate
 * that.
 */
export type QueueMessageHandler<TPayload = unknown> = (message: QueueMessage<TPayload>) => Promise<void>;

export interface QueueSubscription {
  /** Stops pulling new messages and releases the underlying connection. Idempotent. */
  stop(): Promise<void>;
}

export interface QueueAdapter {
  /** Which vendor is actually behind this instance — telemetry/logging only, never branched on by a caller. */
  readonly providerId: string;

  /** Publishes one message to `topic`. `attributes` are provider-native metadata (Pub/Sub message attributes), not part of `payload`. */
  publish(topic: string, payload: unknown, attributes?: Record<string, string>): Promise<PublishResult>;

  /**
   * Starts a long-running pull consumer against `subscription`, invoking
   * `handler` once per message. Returns immediately; messages arrive
   * asynchronously for as long as the returned `QueueSubscription` is open.
   * This is the *pull* consumption model — see
   * `apps/agent-server/src/routes/queue.ts` for the alternative *push*
   * model (a provider delivering messages as HTTP requests instead), which
   * does not go through this method at all.
   */
  subscribe<TPayload = unknown>(subscription: string, handler: QueueMessageHandler<TPayload>): QueueSubscription;
}
