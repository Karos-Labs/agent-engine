/**
 * What every capability in this engine needs, what happens when it is missing,
 * and whether anyone decided that on purpose (AU55 / SCRUM-354).
 *
 * ## Why this exists
 *
 * A missing key here does not fail. It removes a capability quietly, and the
 * system runs with a smaller set of options than anyone believes it has. Four
 * confirmed cases in one week, none of which announced themselves:
 *
 *   - `APIFY_TOKEN` absent in prod: venue photography silently degraded to
 *     generic image search for months.
 *   - Unsplash/Pexels/Pixabay absent in prod: three of six image providers.
 *   - `PUBSUB_PUSH_TOKEN` absent: a SECURITY CHECK that skips itself.
 *   - karosCMO's `SEGMIND_API_KEY`: the inverse — a secret shipped to
 *     production for code that exists nowhere in the repo.
 *
 * The failure is not degradation. Degradation is usually fine, and some of
 * these absences are deliberate. The failure is degradation NOBODY CAN SEE.
 *
 * So this is not "fail when a key is missing". It is "always be able to answer,
 * per environment, what is switched off and what it costs".
 *
 * ## The rule for writing a row
 *
 * `title` and `whenAbsent` are read by someone deciding whether to issue a key
 * or delete a feature. They must be answerable WITHOUT opening the codebase.
 *
 *   BAD:  "APIFY_TOKEN is missing"
 *   GOOD: "Venue photography — image routes fall back to generic web search"
 *
 * If a row cannot be decided from the report alone, the row is not finished.
 *
 * `rationale` is what makes a row EXPECTED rather than UNEXPLAINED. It must
 * point at a real recorded decision — a ticket, a comment in a deploy file, a
 * README. "Probably fine" is not a rationale; leaving it undefined is the
 * honest answer and puts the row at the top of the report, which is the point.
 */

/** How a capability is faring right now, in this environment. */
export type CapabilityStatus =
  /** Everything it needs is present. */
  | "ACTIVE"
  /** Running, but with fewer sources/options than its full configuration. */
  | "DEGRADED"
  /** Switched off entirely — the capability cannot run at all. */
  | "DISABLED";

/** Whether someone decided this, or whether it is a question nobody has been asked. */
export type CapabilityDecision = "EXPECTED" | "UNEXPLAINED";

export interface CapabilityRequirement {
  /** The variable itself. */
  readonly name: string;
  /**
   * `required` — absent means the capability cannot run.
   * `enhances`  — absent means fewer sources/options, capability still runs.
   * `alternative` — one of a set where any ONE satisfies the requirement.
   */
  readonly kind: "required" | "enhances" | "alternative";
}

export interface CapabilityDefinition {
  readonly id: string;
  /** Capability phrasing, not variable phrasing. What a person loses. */
  readonly title: string;
  /** Where it lives, for whoever follows up. */
  readonly owner: string;
  readonly requires: readonly CapabilityRequirement[];
  /** What the system does INSTEAD when this is not fully configured. The most important field. */
  readonly whenAbsent: string;
  /**
   * The recorded decision that makes an absence expected. Undefined means
   * nobody has decided — the row sorts first.
   */
  readonly rationale?: string;
  /**
   * A capability whose absence removes a CHECK rather than a feature. These are
   * holes, not degradations, and are reported separately and first.
   */
  readonly security?: boolean;
}

/**
 * Every capability the engine has that depends on configuration.
 *
 * Grounded in the actual reads: each `name` below is read by code somewhere in
 * this repo (`scripts/config-inventory.ts` cross-checks that claim in CI, so a
 * row naming a variable nothing reads fails the build).
 */
export const CAPABILITY_CATALOGUE: readonly CapabilityDefinition[] = [
  // ── Content production ───────────────────────────────────────────────────
  {
    id: "external-research",
    title: "External research — the live sources every content agent draws facts from",
    owner: "packages/tools/karos-research (research.pull, via the karos-scraper seam)",
    requires: [{ name: "SCRAPPYCOCO_API_KEY", kind: "required" }],
    whenAbsent:
      "research.pull reports not_available and content agents HOLD rather than drafting. This is the one absence that stops work outright, deliberately: a placeholder payload is what let every content agent draft from nothing for months.",
    rationale: "packages/tools/karos-research/README.md — the stand-in was replaced by not_available on purpose.",
  },
  {
    id: "image-search-curated",
    title: "Curated stock photography (Unsplash, Pexels, Pixabay)",
    owner: "packages/tools/karos-media (media.findImages)",
    requires: [
      { name: "UNSPLASH_ACCESS_KEY", kind: "enhances" },
      { name: "PEXELS_API_KEY", kind: "enhances" },
      { name: "PIXABAY_API_KEY", kind: "enhances" },
    ],
    whenAbsent:
      "Those providers do not register. Image sourcing still works from the keyless ones (Openverse, Wikimedia, DuckDuckGo) plus generation, but with a smaller pool and weaker licence tiers — keyless sources are 'attributable' or 'unknown' provenance, never 'blanket'.",
    rationale:
      "cloudbuild.promote.yaml records these as deliberately prep-only: the secrets do not exist in the prod project and --set-secrets naming a missing secret fails the deploy.",
  },
  {
    id: "venue-photography",
    title: "Venue photography — photos verified to be of a specific real place",
    owner: "packages/tools/karos-media (named_venue route)",
    requires: [{ name: "GOOGLE_PLACES_KEY", kind: "required" }],
    whenAbsent:
      "The named_venue route has no place-verified source and falls through to generic image search (DuckDuckGo, Openverse, Wikimedia). A slide asking for a specific venue gets a photo that merely looks plausible, which the rights gate should and usually will refuse.",
    // DECIDED 2026-08 (AU56 / SCRUM-355): option A — issue the key. This row
    // carried no rationale for exactly one working day, which is what it is
    // for: GOOGLE_PLACES_KEY was documented in .env.example and wired in
    // NEITHER cloudbuild, so the route had been falling through both of its
    // intended tiers to generic image search in every environment since it was
    // written, and nothing said so.
    //
    // prep now has the key via Secret Manager (`google-places-key`). PROD DOES
    // NOT — its key has not been created yet, so a prod report still shows this
    // DISABLED. That is correct and intended, and the rationale here is what
    // keeps it EXPECTED rather than a fresh question.
    rationale:
      "AU56 decided to issue the key. prep is wired (Secret Manager: google-places-key); prod's key is not created yet, so prod remains DISABLED until it is.",
  },
  {
    id: "image-generation",
    title: "Image generation — original imagery when no library has the subject",
    owner: "packages/tools/karos-media (image.generate)",
    requires: [
      { name: "GEMINI_VERTEX_PROJECT_ID", kind: "alternative" },
      { name: "GOOGLE_CLOUD_PROJECT", kind: "alternative" },
    ],
    whenAbsent: "The generative tier is unavailable; sourcing must find something in a library or the slide goes unfilled.",
    rationale: "Satisfied by GOOGLE_CLOUD_PROJECT, which every deployed environment sets.",
  },

  // ── Video ────────────────────────────────────────────────────────────────
  {
    id: "video-transcription",
    title: "Video transcription — turning a source video into the transcript every clip decision is made from",
    owner: "packages/tools/karos-video (video.transcribe)",
    requires: [{ name: "ELEVENLABS_API_KEY", kind: "required" }],
    whenAbsent: "video.transcribe reports not_available, so branded-shorts and tiktok runs cannot plan a cut at all.",
  },
  {
    id: "video-engine",
    title: "Video rendering and its craft gates (cut, brand, graphics, colour)",
    owner: "packages/tools/karos-video",
    requires: [{ name: "BRANDED_SHORTS_ENGINE_DIR", kind: "required" }],
    whenAbsent:
      "Every video.* gate returns tooling_error naming the missing engine checkout, and a branded-shorts run fails rather than shipping unchecked footage (AU8 made this a real tooling_error outcome rather than a success carrying an error verdict).",
  },

  // ── Reputation ───────────────────────────────────────────────────────────
  {
    id: "reputation-capture",
    title: "Review capture from Google Business Profile and Yelp",
    owner: "packages/tools/karos-reputation (reputation.capture)",
    requires: [
      { name: "GOOGLE_BUSINESS_TOKEN", kind: "enhances" },
      { name: "YELP_API_KEY", kind: "enhances" },
    ],
    whenAbsent:
      "Those legs write an UNAVAILABLE tombstone instead of reviews. The pulse still runs on whatever legs are configured, and the tombstone keeps the gap visible rather than reading as 'no reviews this month'.",
  },

  // ── Landing builder ──────────────────────────────────────────────────────
  {
    id: "landing-builder",
    title: "Landing page building — the template kit a generated site is composed from",
    owner: "packages/tools/karos-landing",
    requires: [
      { name: "LANDING_ENGINE_TEMPLATE_ROOT", kind: "required" },
      { name: "LANDING_ENGINE_ROOT", kind: "required" },
    ],
    whenAbsent: "Every landing.* tool returns tooling_error, so landing-builder runs cannot start.",
    rationale: "Both are set in cloudbuild.yaml and cloudbuild.promote.yaml for deploy-http and deploy-worker.",
  },

  // ── Persistence ──────────────────────────────────────────────────────────
  {
    id: "durable-workspace",
    title: "Durable tenant state — brand kits, topics, memory, the deliverable ledger",
    owner: "packages/tools/common (createWorkspaceStoreFromEnv)",
    requires: [{ name: "GCS_WORKSPACE_BUCKET", kind: "required" }],
    whenAbsent:
      "Falls back to LOCAL DISK, silently and without erroring. On Cloud Run that means each instance reads an empty workspace: every client tool returns 'not set up yet' for a fully onboarded client, and anything written vanishes on instance recycle. This is the single most dangerous absence in this table because nothing about it looks like a failure (T-P0b / SCRUM-263).",
    rationale: "Wired in both cloudbuild files for both services, and pinned by apps/agent-server/__tests__/workspace-store-wiring.test.ts.",
  },
  {
    id: "media-artifact-storage",
    title: "Rendered media and archived run output stored outside the container",
    owner: "packages/tools/common (createArtifactStoreFromEnv)",
    requires: [
      { name: "GCS_MEDIA_BUCKET", kind: "enhances" },
      { name: "GCS_ARTIFACTS_BUCKET", kind: "enhances" },
    ],
    whenAbsent:
      "Renders stay on the container's ephemeral disk and are lost on recycle; oversized step output stays inline in Firestore instead of being archived.",
    rationale: "Both wired in cloudbuild for both services.",
  },
  {
    id: "prompt-store",
    title: "Prompt serving — the craft policy every agent step runs on",
    owner: "packages/core (createPromptStoreFromEnv)",
    requires: [{ name: "PROMPT_STORE_DRIVER", kind: "required" }],
    whenAbsent:
      "Defaults to an EMPTY in-memory store. The server boots clean and then every skillRef resolution fails at run time, so 100% of agent steps degrade with no startup error. Fail-quiet in exactly the way this catalogue exists to surface.",
    rationale: "Set to 'firestore' in both cloudbuild files for both services.",
  },

  // ── Observability ────────────────────────────────────────────────────────
  {
    id: "tracing",
    title: "Distributed tracing — per-step latency and failure attribution",
    owner: "packages/telemetry",
    requires: [{ name: "GOOGLE_CLOUD_PROJECT", kind: "required" }],
    whenAbsent: "initTelemetry() is a no-op. Runs still work; nothing is traced, so a slow or failing step cannot be attributed after the fact.",
    rationale: "Set in both cloudbuild files.",
  },
  {
    id: "cost-accounting",
    title: "Cost and token accounting per run",
    owner: "packages/telemetry (BigQuery sink)",
    requires: [
      { name: "BQ_PROJECT_ID", kind: "alternative" },
      { name: "GOOGLE_CLOUD_PROJECT", kind: "alternative" },
      { name: "BQ_DATASET_ID", kind: "enhances" },
    ],
    whenAbsent: "Per-step cost rows are not written. Spend becomes invisible per client and per agent.",
    rationale: "BQ_PROJECT_ID is set in cloudbuild.yaml; prod falls back to GOOGLE_CLOUD_PROJECT, which is correct for that project.",
  },

  // ── Model routing ────────────────────────────────────────────────────────
  {
    id: "model-fallback-anthropic",
    title: "Direct-Anthropic fallback when the Vertex route is rate-limited or a model is unavailable there",
    owner: "packages/core (ResilientClaudeAdapter)",
    requires: [{ name: "ANTHROPIC_API_KEY", kind: "required" }],
    whenAbsent: "A 429 or 404 on the Vertex route has one fewer hop before it reaches the Gemini last resort.",
    rationale: "Wired from Secret Manager in both cloudbuild files.",
  },
  {
    id: "model-vendor-alternatives",
    title: "Non-Anthropic model vendors (Gemini direct, Model Garden, OpenAI-compatible)",
    owner: "packages/core (createModelRouterFromEnv)",
    requires: [
      { name: "GEMINI_API_KEY", kind: "enhances" },
      { name: "MODEL_GARDEN_PROJECT_ID", kind: "enhances" },
      { name: "OPENAI_COMPATIBLE_BASE_URL", kind: "enhances" },
      { name: "OPENAI_COMPATIBLE_API_KEY", kind: "enhances" },
      { name: "OPENAI_API_KEY", kind: "enhances" },
    ],
    whenAbsent:
      "Those vendors are not built. A step whose modelPolicy names one fails loudly at the point of use naming the exact missing variable — which is correct, and is why this is not a silent degradation.",
    rationale: "agent_vendor_switching.md: no agent sets a non-default vendor today, so none of these is needed until one does.",
  },

  // ── Security: absences that remove a CHECK, not a feature ────────────────
  {
    id: "push-shared-secret",
    title: "Pub/Sub push shared-secret check — the second layer in front of the run-starting endpoint",
    owner: "apps/agent-server (routes/queue.ts)",
    requires: [{ name: "PUBSUB_PUSH_TOKEN", kind: "required" }],
    whenAbsent:
      "The ?token= check SKIPS ITSELF. Not a smaller feature — one fewer barrier in front of an endpoint that starts billable runs. Safe only while the OIDC layer beside it is configured and fails closed.",
    security: true,
  },
  {
    id: "push-oidc",
    title: "Pub/Sub push identity verification",
    owner: "apps/agent-server (routes/queue.ts)",
    requires: [{ name: "PUBSUB_PUSH_AUDIENCE_URL", kind: "required" }],
    whenAbsent: "OIDC verification is skipped entirely and any caller past Cloud Run IAM can start a run through the push endpoint.",
    rationale: "Wired in both cloudbuild files for deploy-http (AU2 / SCRUM-288).",
    security: true,
  },
  {
    id: "service-identity-auth",
    title: "Caller authentication on the HTTP API",
    owner: "apps/agent-server (auth/service-identity.ts)",
    requires: [
      { name: "AUTH_ENABLED", kind: "required" },
      { name: "AUTH_AUDIENCE", kind: "required" },
    ],
    whenAbsent:
      "Every route is reachable by anything that can invoke the Cloud Run service, with no application-layer identity check. Tenancy below the API stays structural, but the API itself performs no authorisation.",
    rationale:
      "AUTH_ENABLED ships false on purpose (AU1 / SCRUM-287). Enabling it is SCRUM-331, blocked on SCRUM-330 (the portal's fail-open token fetch). AUTH_AUDIENCE is already wired so the flag can be flipped in one change.",
    security: true,
  },
  {
    id: "local-dev-auth-bypass",
    title: "Local development sign-in — a static token standing in for a Google identity",
    owner: "apps/agent-server (auth/service-identity.ts)",
    requires: [{ name: "AUTH_DEV_TOKEN", kind: "enhances" }],
    whenAbsent:
      "curl and a local portal cannot authenticate against a locally-enabled auth setup; they must mint a real Google identity token instead. Absent is the SAFE state, and this row exists so that its PRESENCE is visible: a stray value on a deployment that reads as production is refused outright by isProduction, but the report should still show it rather than leave it unaccounted for.",
    rationale: "Unset everywhere, which is correct. It is refused outright when FIRESTORE_DATABASE_ID is not 'prep', so it cannot become a production bypass.",
    security: true,
  },
  {
    id: "dynamic-code-steps",
    title: "Dynamic code steps — running Studio-authored code inside a sandbox",
    owner: "packages/dynamic-sandbox",
    requires: [{ name: "DYNAMIC_CODE_STEPS_ENABLED", kind: "required" }],
    whenAbsent: "A dynamic agent definition containing a code stage fails that stage rather than executing it.",
    rationale: "Deliberately off: the module's own comment records that sandbox hardening has had no security review.",
    security: true,
  },
] as const;

/** Every variable named anywhere in the catalogue. `scripts/config-inventory.ts` checks this against what the code actually reads. */
export function catalogueVariables(): readonly string[] {
  return [...new Set(CAPABILITY_CATALOGUE.flatMap((c) => c.requires.map((r) => r.name)))].sort();
}
