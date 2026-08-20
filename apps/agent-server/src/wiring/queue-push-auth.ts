import { OAuth2Client } from "google-auth-library";
import type { VerifyPushIdToken } from "../routes/queue.js";

/**
 * The real `VerifyPushIdToken` — verifies a Pub/Sub push request's OIDC
 * identity token the way Google's own docs describe
 * (https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions):
 * the subscription is configured with a `--push-auth-service-account`,
 * which Pub/Sub uses to mint a fresh ID token on every push, with this
 * endpoint's own URL as the token's audience. `OAuth2Client.verifyIdToken`
 * itself throws on an invalid/expired/wrong-audience token, which is
 * exactly `VerifyPushIdToken`'s own contract — no additional wrapping
 * needed.
 */
export function createQueuePushVerifier(): VerifyPushIdToken {
  const client = new OAuth2Client();
  return async (idToken, audience) => {
    await client.verifyIdToken({ idToken, audience });
  };
}
