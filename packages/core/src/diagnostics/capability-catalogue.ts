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
 *   - `PUBSUB_PUSH_TOKEN` absent: a SECURITY CHECK that skipped itself. Deleted
 *     outright in SCRUM-333 rather than wired — see below.
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
  | "DISABLED"
  /**
   * Decided, not yet built (the capability-by-product work — shipped without a Jira ticket).
   *
   * The three statuses above all describe CONFIGURATION: something is present,
   * partly present, or absent, and issuing a key changes the answer. This one
   * does not. The thing the variable would configure DOES NOT EXIST YET —
   * separately scheduled work with a ticket. Issuing the key would change
   * nothing.
   *
   * Without this value such a row had nowhere to live. It landed as DISABLED
   * with no rationale, i.e. UNEXPLAINED, i.e. indistinguishable from an
   * oversight — which quietly devalues the one list that is supposed to mean
   * exactly one thing.
   */
  | "PENDING_BUILD";

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
  /**
   * Present when the thing this capability configures is scheduled work that
   * has not been built (the capability-by-product work — shipped without a Jira ticket). Forces `PENDING_BUILD` regardless of
   * the environment, because issuing the key would not help.
   *
   * The ticket is what makes the row EXPECTED rather than UNEXPLAINED. It is
   * required, not optional: "not built yet" without a ticket is exactly the
   * unrecorded decision `rationale` exists to catch, and letting it in through
   * a side door would defeat the point.
   */
  readonly pendingBuild?: {
    /** The ticket that scheduled it. */
    readonly ticket: string;
    /** At most a handful of words, for the product headline: "render engine pending development". */
    readonly summary: string;
  };
  /**
   * A short phrase naming what is MISSING, for the one-line product headline
   * ("no transcription key", "render engine pending development"). Required on
   * any capability some product lists in `requires` — a test enforces that —
   * because `title` describes what the capability IS, and a headline needs what
   * it LACKS.
   */
  readonly shortfall?: string;
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
    shortfall: "no research source",
  },
  {
    id: "seo-geo-ai-visibility-capture",
    title: "SEO & GEO AI-visibility capture — real per-engine answers for research.captureVisibility's captured engines (T-A3/SCRUM-237)",
    owner: "packages/tools/karos-research (research.captureVisibility, packages/tools/karos-research/src/capture-adapters)",
    requires: [
      { name: "PERPLEXITY_API_KEY", kind: "enhances" },
      { name: "GEMINI_API_KEY", kind: "enhances" },
      { name: "OPENAI_API_KEY", kind: "enhances" },
    ],
    whenAbsent:
      "Each engine's cells report UNAVAILABLE/no_adapter_wired, honestly, exactly like every other unconfigured engine — never a fabricated MEASURED/ESTIMATED answer. Claude's capture independently depends on ANTHROPIC_API_KEY, a row elsewhere in this catalogue for another capability, rather than a new credential. GEMINI_API_KEY is carried on THIS row rather than reused from a model-routing row: AU59/SCRUM-358 removed the direct-Gemini model route and its row, so capture is now this variable's only reader — and absent it, Gemini falls back to the Vertex route on ADC, which needs no credential of its own and so has no entry here. OPENAI_API_KEY backs the ChatGPT column via the Responses API's web_search tool; it replaced a ScrappyCoco route that never worked, so SCRAPPYCOCO_API_KEY is no longer read by capture at all (it still backs research.pull's scraper, its own row). Copilot has no route in this build and is out of the fan-out entirely rather than wired to something that throws.",
    rationale: "packages/tools/karos-research/src/capture-visibility.ts's own header comment — an engine with no adapter configured degrades per-engine, never all-or-nothing.",
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
      "Wired in BOTH cloudbuild files since 2026-09-06. They were prep-only while karoscmo genuinely had no such secrets, and the instruction attached to that state was to create them there and add the line — by the time anyone looked, the secrets existed and only the comment was still enforcing the old world. Verified 2026-09-06 against the prod project: each secret exists with an enabled version AND answers its own API (the elevenlabs-api-key incident — mounted for weeks in prep while returning 401 — is why presence alone is not the claim).",
    shortfall: "no curated stock photography",
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
      "AU56 decided to issue the key; both environments are wired (Secret Manager: google-places-key), prod since 2026-09-06. Checked against `maps/api/place/findplacefromtext` — the endpoint providers/google-places.ts actually calls — not against places.googleapis.com, which is enabled in neither project and which this code does not use. Verified 2026-09-06 against the prod project: each secret exists with an enabled version AND answers its own API (the elevenlabs-api-key incident — mounted for weeks in prep while returning 401 — is why presence alone is not the claim).",
    shortfall: "no venue photography",
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
    shortfall: "no image generation",
  },
  {
    id: "vision-inspection",
    title: "Vision inspection — a model that looks at the pictures a post will carry",
    owner: "packages/tools/karos-media (media.inspectImages)",
    requires: [
      { name: "GEMINI_VERTEX_PROJECT_ID", kind: "alternative" },
      { name: "GOOGLE_CLOUD_PROJECT", kind: "alternative" },
    ],
    whenAbsent:
      "A client-attached image is described to the copy step from its upload label only, so the words are written beside the picture rather than to it; sourced candidates are judged from provider alt text and licence lines alone, so a watermark or a cookie-wall screenshot is caught only if the text happens to say so.",
    rationale: "Same Vertex credential as image generation; satisfied by GOOGLE_CLOUD_PROJECT, which every deployed environment sets.",
    shortfall: "images judged from text, not pixels",
  },

  // ── Video ────────────────────────────────────────────────────────────────
  {
    id: "video-transcription",
    title: "Video transcription — turning a source video into the transcript every clip decision is made from",
    owner: "packages/tools/karos-video (video.transcribe)",
    requires: [{ name: "ELEVENLABS_API_KEY", kind: "required" }],
    whenAbsent:
      "video.transcribe reports not_available: a tiktok commentary clip cannot plan a cut (the run holds at 02-transcribe), and an original short's voiceover captions fall back to per-beat timing instead of word timing. branded-shorts cannot plan a cut either — and since its render engine now ships inside the image (video-engine, below), this key is the last thing between that product and a first real render rather than one blocker behind another.",
    shortfall: "no transcription key",
    rationale:
      "Wired in cloudbuild.yaml (--set-secrets ELEVENLABS_API_KEY=elevenlabs-api-key) since the tiktok smart-pipeline change, and in cloudbuild.promote.yaml since 2026-09-06 — the secret exists in karoscmo as well, which is what that line requires. Two silent failures preceded this, in the same place: the secret sat in karoscmo-prep for weeks MOUNTED NOWHERE (every prep tiktok run died at 02-transcribe, verified 2026-09-05), and once mounted it held a key ElevenLabs rejected with 401 (verified against /v1/user/subscription on 2026-09-06, then replaced as version 2 in both projects). A mounted secret is not a working credential, and neither absence announced itself — which is this catalogue's whole subject.",
  },
  {
    id: "video-harvest",
    title: "Footage harvest — clipping an episode of a show the client holds rights to, found by topic",
    owner: "packages/tools/karos-media (media.harvestVideo, providers/yt-dlp-harvest.ts)",
    requires: [
      { name: "VIDEO_HARVEST_PROVIDER", kind: "required" },
      { name: "YT_DLP_COOKIES_FILE", kind: "enhances" },
      { name: "YT_DLP_BIN", kind: "enhances" },
    ],
    whenAbsent:
      "media.harvestVideo reports not_available and the tiktok cascade skips from the client's own footage straight to generated b-roll — a client with a sourcePool of shows but no uploaded episode never gets a commentary clip, only original shorts.",
    shortfall: "no footage harvest",
    rationale:
      "Set to yt-dlp in BOTH cloudbuild files (prod since 2026-09-06 — it needs no secret, since yt-dlp is installed in the image, and prod had simply never been given the line). The cookies file is optional and only needed when YouTube challenges the Cloud Run egress IP; absent, an affected download is a content_fail the cascade routes around. Whether a given show may be clipped stays a per-client rights question, which this variable does not answer.",
  },
  {
    id: "video-voiceover",
    title: "Voiceover — a spoken narration for an original short",
    owner: "packages/tools/karos-video (video.synthesizeVoice)",
    requires: [
      { name: "GOOGLE_CLOUD_PROJECT", kind: "alternative" },
      { name: "ELEVENLABS_API_KEY", kind: "alternative" },
    ],
    whenAbsent:
      "video.synthesizeVoice reports not_available. An original short whose script (or client config) wants a voice holds; one that runs silent is unaffected.",
    shortfall: "no voiceover",
    rationale: "Google Cloud Text-to-Speech authenticates with the server's own ADC (the composition root passes `authorize`), so every deployed environment has it; ElevenLabs is the alternative and the fallback.",
  },
  {
    id: "video-visual-qa",
    title: "Visual QA — a vision model watches the finished clip before a human does",
    owner: "packages/tools/karos-media (video.visualQaGate)",
    requires: [
      { name: "GEMINI_VERTEX_PROJECT_ID", kind: "alternative" },
      { name: "GOOGLE_CLOUD_PROJECT", kind: "alternative" },
      { name: "VIDEO_QA_MODEL", kind: "enhances" },
    ],
    whenAbsent: "The gate reports not_available and the tiktok run records the clip as proceeding to the human gate UNREVIEWED — never as passed.",
    shortfall: "no visual QA",
    rationale: "Satisfied by GOOGLE_CLOUD_PROJECT, which every deployed environment sets. VIDEO_QA_MODEL only swaps the model (default gemini-2.5-flash).",
  },
  {
    id: "video-engine",
    title: "Video rendering and its craft gates (cut, brand, graphics, colour)",
    owner: "packages/tools/karos-video (engine/ — vendored from karos-agents' branded-shorts product)",
    requires: [{ name: "BRANDED_SHORTS_ENGINE_DIR", kind: "required" }],
    whenAbsent:
      "Every video.* gate returns tooling_error naming the missing engine directory, and a branded-shorts or tiktok run fails rather than shipping unchecked footage (AU8 made this a real tooling_error outcome rather than a success carrying an error verdict). Absent only OUTSIDE the container: the engine ships inside the image at packages/tools/karos-video/engine and apps/agent-server/Dockerfile pins this variable at that path, so a deployed service always has it — a local checkout has to point it at the same directory.",
    shortfall: "no render engine",
    rationale:
      "SPEC-AU63 option A, decided 2026-09-06: the engine (SCRUM-362) is vendored in-repo and pinned by the Dockerfile's ENV, never injected per deploy — apps/agent-server/__tests__/video-engine-in-image.test.ts asserts every script the adapters name is in the build context.",
  },

  // ── Reputation ───────────────────────────────────────────────────────────
  {
    id: "reputation-capture",
    title: "Review capture from Google Business Profile — the credentialed review source",
    owner: "packages/tools/karos-reputation (reputation.capture, reputation.discoverGbpLocations)",
    requires: [{ name: "GOOGLE_BUSINESS_TOKEN", kind: "enhances" }],
    whenAbsent:
      "Since 2026-09-06 the GBP legs fall back to a business.manage token minted from the worker's own service account (Application Default Credentials, wired in apps/agent-server/src/wiring/tools.ts), so the variable is an override for a user token, not the only credential. That fallback reaches exactly the Business Profiles a person has added the service account to as a manager; for every other client the GBP leg writes an UNAVAILABLE tombstone naming that gap, and the pulse runs on only the uncredentialed legs (App Store RSS, and whatever the client exports by hand). The tombstone keeps that visible rather than letting it read as 'no reviews this month'.",
    shortfall: "no Google reviews without profile access",
    rationale:
      "Decided 2026-09-06: no deployment ever carried GOOGLE_BUSINESS_TOKEN, so the leg was a guaranteed tombstone; the service account is the credential the engine already runs with, and adding it as a profile manager is a per-client step a person can do in Business Profile Manager. A user grant WAS then pasted (2026-09-07, both projects) and is wired alongside GOOGLE_OAUTH_CLIENT_ID/SECRET — but it is a REFRESH token, not the access token this variable was designed for, so gbp-credential.ts exchanges it and falls back to ADC when it cannot: filling this variable in must never remove the credential that already worked. The two OAuth secrets arrived CROSSED between the projects (each held the other project's app, so every exchange returned unauthorized_client while both looked present); corrected by testing each token against each client, and both now exchange for scope business.manage. NEITHER credential reaches reviews yet, for a reason no variable can express: Google's Business Profile access is unapproved for these projects. The API quota is literally 0 (DefaultRequestsPerMinutePerProject — verified 429/RESOURCE_EXHAUSTED with a valid minted token, i.e. authentication SUCCEEDING), and mybusiness.googleapis.com — the legacy v4 surface where reviews live and the only one this adapter calls — cannot even be enabled (AUTH_PERMISSION_DENIED binding the service; it is allow-list-only). So a credential being present here says nothing about reviews arriving until that approval lands.",
  },

  // ── Google first-party connectors (SEO/GEO Layer 1) ──────────────────────
  {
    id: "google-connectors-oauth",
    title: "Google first-party SEO data — Search Console rankings, GA4 AI-referral outcomes, Business Profile listing",
    owner: "packages/tools/karos-connectors (connectors.googleDataSync)",
    requires: [
      { name: "GOOGLE_OAUTH_CLIENT_ID", kind: "required" },
      { name: "GOOGLE_OAUTH_CLIENT_SECRET", kind: "required" },
      { name: "GSC_SERVICE_ACCOUNT_KEY", kind: "enhances" },
      { name: "GSC_SITE_URL", kind: "enhances" },
    ],
    whenAbsent:
      "Every client stays on the SEO/GEO Layer-2 path, which is the validated default and produces a complete, scored, deliverable 0-100 result on its own. What is lost is accuracy and detail, not the score: real Google positions/impressions/clicks show an honest empty state instead of numbers, GEO-01/41's AI-features opt-out leg drops from its denominator (partial credit over the remaining robots legs), GEO-28 reads a proxy labelled 'estimated (proxy)' instead of real AI-surface impressions, and GA4's AI-referral panel shows 'Connect Google Analytics to measure' rather than a fabricated zero. Each connector's snapshot hash resolves to the literal UNCONNECTED.",
    rationale:
      "packages/tools/karos-seo-geo/src/config/connectors-config.data.ts works_unconnected.guarantee — connecting Google is a per-input accuracy upgrade and never a hard dependency; revoking cannot break the product.",
    shortfall: "no Google connection — first-party SEO data unavailable",
  },
  {
    id: "google-connectors-psi",
    title: "Core Web Vitals field data — real-user p75 LCP/INP/CLS from PageSpeed Insights / CrUX",
    owner: "packages/tools/karos-connectors (connectors.googleDataSync)",
    requires: [{ name: "PSI_API_KEY", kind: "required" }],
    whenAbsent:
      "SEO-04 scores from the lab p75 the Lighthouse audit already produces, against the SAME 8/7/5 bands — the Technical/CWV bucket scores in full either way. The field-data swap changes the measured value and its confidence label (estimated -> measured_field), not the formula. Note the key alone does not switch anything: field data is read only for a client who has also set the per-client Google-connect opt-in, so the lab->field move is always a logged per-client source change (Defect-2).",
    rationale: "connectors-config.data.ts crux_per_client_gate, and per_metric_degradation's SEO-04 line.",
    shortfall: "no field CWV — lab p75 only",
  },

  // ── Landing builder ──────────────────────────────────────────────────────
  {
    id: "landing-hosting",
    title: "Landing page publishing — the Firebase Hosting project a client's page goes live on",
    owner: "packages/tools/karos-landing (landing.deployPage)",
    requires: [
      { name: "LANDING_HOSTING_PROJECT", kind: "required" },
      { name: "LANDING_HOSTING_SITE_PREFIX", kind: "required" },
    ],
    whenAbsent:
      "The page is still built, checked, rendered and archived to GCS, and the reviewer gets a 7-day signed URL to index.html instead of a live .web.app preview; approval then produces no public URL, so the deliverable carries only the GCS prefix.",
    rationale: "Set in cloudbuild.yaml (prefix karos-prep-) and cloudbuild.promote.yaml (prefix karos-) for deploy-http and deploy-worker; the worker service account needs roles/firebasehosting.admin on that project.",
    shortfall: "no live landing page URL",
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
    shortfall: "no durable workspace",
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
    shortfall: "no media storage",
  },
  {
    id: "prompt-store",
    title: "Prompt serving — the craft policy every agent step runs on",
    owner: "packages/core (createPromptStoreFromEnv)",
    requires: [{ name: "PROMPT_STORE_DRIVER", kind: "required" }],
    whenAbsent:
      "Defaults to an EMPTY in-memory store. The server boots clean and then every skillRef resolution fails at run time, so 100% of agent steps degrade with no startup error. Fail-quiet in exactly the way this catalogue exists to surface.",
    rationale: "Set to 'firestore' in both cloudbuild files for both services.",
    shortfall: "no prompt store",
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
    rationale:
      "BQ_PROJECT_ID is set in cloudbuild.yaml; prod falls back to GOOGLE_CLOUD_PROJECT, which is correct for that project. BQ_DATASET_ID is pinned to bi_telemetry in both cloudbuild files, so the dataset half of the address is stated in the deploy config rather than inherited from bigquery-client.ts's default.",
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
    title: "Non-Anthropic model vendors reached through Vertex AI (Gemini, Model Garden)",
    owner: "packages/core (createModelRouterFromEnv)",
    requires: [{ name: "MODEL_GARDEN_PROJECT_ID", kind: "enhances" }],
    whenAbsent:
      "Model Garden is not built. A step whose modelPolicy names it fails loudly at the point of use naming the exact missing variable — which is correct, and is why this is not a silent degradation. (Gemini's own Agent Platform route needs no separate opt-in beyond GEMINI_VERTEX_PROJECT_ID / GOOGLE_CLOUD_PROJECT, already required elsewhere.)",
    rationale:
      "agent_vendor_switching.md: no agent sets a non-default vendor today, so this is not needed until one does. AU59/SCRUM-358 (Vertex-only model surface) removed the direct-Gemini and OpenAI-compatible routes outright, so they were dropped from this row rather than left as orphaned rows. Nothing reads OPENAI_COMPATIBLE_BASE_URL / OPENAI_COMPATIBLE_API_KEY / OPENAI_API_KEY any more. GEMINI_API_KEY is the exception: no MODEL route reads it, but T-A3/SCRUM-237 reintroduced it for Gemini Grounding visibility capture, so it is a live credential on the seo-geo-ai-visibility-capture row — not here.",
  },

  // ── Security: absences that remove a CHECK, not a feature ────────────────
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
      "AUTH_ENABLED shipped false on purpose (AU1 / SCRUM-287) while SCRUM-330 (the portal's fail-open token fetch) was outstanding. SCRUM-331 (AU48) turned it ON in PREP on 2026-09-02, once SCRUM-330 was merged and deployed there; the value is pinned in cloudbuild.yaml rather than injected, so it cannot arrive from outside that file. PRODUCTION stays false until the portal promotion carries SCRUM-330 there — enabling first would turn a metadata blip into an intermittent 401. The worker surface has no AUTH_* variables at all and needs none: it is a Pub/Sub PULL consumer with no inbound HTTP.",
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
    id: "tenant-assertion",
    title: "Tenant entitlement at the HTTP edge",
    owner: "apps/agent-server (auth/tenant-assertion.ts)",
    requires: [
      { name: "TENANT_ASSERTION_ENABLED", kind: "required" },
      { name: "TENANT_ASSERTION_SECRET", kind: "required" },
    ],
    whenAbsent:
      "clientSlug stays caller-asserted: service-identity-auth (above) proves the portal called, but nothing checks that a given request's clientSlug is the one the portal is actually entitled to act for on behalf of. A runId-addressed route (status, resume, deliverables) trusts whichever clientSlug the stored run record names, with no cross-check against who is asking.",
    rationale:
      "AU46 / SCRUM-329, decision 9 (Tomer, 2026-08-28, SCRUM-333 comment 10404): the portal signs a per-request tenant assertion; the engine verifies it. Off by default because the portal-side signer does not exist in karosCMO yet — see docs/decisions/AU46-tenant-identity.md.",
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
