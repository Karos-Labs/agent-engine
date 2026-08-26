import { Router } from "express";
import { z } from "zod";
import { describeError, logWarning } from "@agent-engine/telemetry";
import { RunJobRequestSchema, startRunJob } from "../run-job.js";
import type { RunsRouterDeps } from "./runs.js";

/**
 * Verifies a Pub/Sub push request's OIDC identity token against the
 * expected audience (the push endpoint's own URL) — the mechanism GCP's own
 * docs recommend for authenticating a push subscription
 * (`--push-auth-service-account` on the subscription + `roles/run.invoker`
 * for that service account on this Cloud Run service). Injected rather than
 * constructed inside this router, matching every other real-client
 * dependency in this codebase (`RunsRouterDeps.generateRunId`/`now`, every
 * `ModelAdapter`): the real implementation
 * (`google-auth-library`'s `OAuth2Client.verifyIdToken`) is built once at
 * `server.ts`'s composition root, and tests inject a fake that never makes
 * a network call.
 */
export type VerifyPushIdToken = (idToken: string, audience: string) => Promise<void>;

export interface QueueRouterDeps extends Pick<RunsRouterDeps, "durableStore" | "runtimeDeps" | "agentDefinitionStore"> {
  /**
   * Shared-secret defense-in-depth, checked as `?token=` on the push URL
   * itself — independent of OIDC verification below, so a misconfigured or
   * cloned subscription still can't reach this endpoint even if OIDC
   * verification were somehow bypassed. Omit to disable this check (e.g.
   * for local testing against the pull-based `queue-consumer.ts` instead,
   * which never uses this route at all).
   */
  pushToken?: string;
  /**
   * The exact HTTPS URL Pub/Sub is configured to push to
   * (`https://<service-url>/api/v1/queue/pubsub-push`) — required as the
   * expected `audience` for OIDC verification. Omit only to skip OIDC
   * verification entirely (e.g. local testing without a real push
   * subscription configured) — never omit this in production.
   */
  pushAudienceUrl?: string;
  /** Real implementation supplied by `server.ts`; tests inject a fake. Required only when `pushAudienceUrl` is set. */
  verifyPushIdToken?: VerifyPushIdToken;
}

/**
 * The push envelope Pub/Sub itself wraps every delivered message in
 * (https://cloud.google.com/pubsub/docs/push#receive_push) — NOT this
 * system's own `RunJobRequestSchema`, which is nested one level down inside
 * `message.data`, base64-encoded.
 */
const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    messageId: z.string().optional(),
    // Some client libraries/older docs use snake_case; accept both rather
    // than silently 400-ing a correctly-configured subscription over a
    // naming convention this endpoint doesn't actually care about.
    message_id: z.string().optional(),
    attributes: z.record(z.string(), z.string()).optional(),
  }),
  subscription: z.string().optional(),
});

/** `/api/v1/queue/pubsub-push` — the push-delivery entry point for run-job messages (see `queue-consumer.ts` for the pull-based alternative). */
export function createQueueRouter(deps: QueueRouterDeps): Router {
  const router = Router();

  router.post("/api/v1/queue/pubsub-push", async (req, res) => {
    if (deps.pushToken !== undefined && req.query["token"] !== deps.pushToken) {
      res.status(401).json({ error: "invalid or missing push token" });
      return;
    }

    if (deps.pushAudienceUrl !== undefined) {
      const authHeader = req.header("authorization");
      const bearer = authHeader?.match(/^Bearer (.+)$/)?.[1];
      if (!bearer) {
        res.status(401).json({ error: "missing bearer token" });
        return;
      }
      if (!deps.verifyPushIdToken) {
        // A misconfiguration, not a client error — fail loudly rather than
        // silently accepting unauthenticated pushes because the verifier
        // was never wired up.
        res.status(500).json({ error: "pushAudienceUrl is set but no verifyPushIdToken was provided" });
        return;
      }
      try {
        await deps.verifyPushIdToken(bearer, deps.pushAudienceUrl);
      } catch (err) {
        // The reason stays server-side: telling an unauthenticated caller which
        // part of their token failed verification is free reconnaissance.
        logWarning(`rejected a Pub/Sub push identity token: ${describeError(err)}`);
        res.status(401).json({ error: "push token verification failed" });
        return;
      }
    }

    const envelope = PushEnvelopeSchema.safeParse(req.body);
    if (!envelope.success) {
      res.status(400).json({ error: "invalid Pub/Sub push envelope", details: envelope.error.issues });
      return;
    }

    const messageId = envelope.data.message.messageId ?? envelope.data.message.message_id;
    if (!messageId) {
      res.status(400).json({ error: "push envelope is missing message.messageId" });
      return;
    }

    let payloadJson: unknown;
    try {
      payloadJson = JSON.parse(Buffer.from(envelope.data.message.data, "base64").toString("utf8"));
    } catch {
      res.status(400).json({ error: "message.data is not valid base64-encoded JSON" });
      return;
    }

    const parsedPayload = RunJobRequestSchema.safeParse(payloadJson);
    if (!parsedPayload.success) {
      // 400, not 200: a permanently-malformed message can't self-heal on
      // retry, but silently swallowing it here would hide the bug that
      // produced it. The subscription's own max-delivery-attempts +
      // dead-letter-topic config (see .env.example) is what decides how
      // many times Pub/Sub retries a non-2xx before giving up — no
      // hand-rolled dead-lettering needed in this handler.
      res.status(400).json({ error: "invalid run-job payload", details: parsedPayload.error.issues });
      return;
    }

    // Deterministic runId derived from Pub/Sub's own messageId: a
    // redelivery of the SAME unacked message reuses the SAME messageId, so
    // this makes a retried delivery land on the exact same runId — and
    // `WorkflowEngine.run()` already treats re-invoking an existing,
    // completed runId as a safe, idempotent no-op (see its own doc
    // comment), so at-least-once Pub/Sub delivery can never double-run a
    // job. See `run-job.ts`.
    const runId = `pubsub-${messageId}`;

    const outcome = await startRunJob(parsedPayload.data, runId, {
      durableStore: deps.durableStore,
      runtimeDeps: deps.runtimeDeps,
      ...(deps.agentDefinitionStore ? { agentDefinitionStore: deps.agentDefinitionStore } : {}),
    });

    if (outcome.outcome === "error" || outcome.outcome === "not_found") {
      // 5xx tells Pub/Sub to redeliver per the subscription's own backoff —
      // after maxDeliveryAttempts it lands on the configured dead-letter
      // topic with zero extra code here. "not_found" (Task 2: an unknown
      // productId) is just as permanent as any other resolution failure —
      // same handling, not a special case.
      res.status(500).json({ error: "run failed unexpectedly", message: outcome.message });
      return;
    }
    // "conflict" only ever means this exact runId was already mid-flight —
    // rare for a queue with no client-side retry pressure, but possible if
    // Pub/Sub redelivers the same message a second time before the first
    // delivery's ack has landed. 200 acks it either way: the other
    // in-flight delivery owns the run.
    res.status(200).json({
      runId: outcome.runId,
      status: outcome.outcome === "started" ? outcome.status : "already-running",
    });
  });

  return router;
}
