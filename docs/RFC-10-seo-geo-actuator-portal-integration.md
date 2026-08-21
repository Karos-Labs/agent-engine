# RFC-10: Wiring the SEO & GEO Actuator into the karosCMO Portal

**Depends on:** RFC-09 (the actuator design), RFC-01 §7 (the real `DynamicAgentSpec`/`DynamicAgentJobPayload` integration contract)
**Source material (read directly this session):** `karosCMO/src/lib/seo-geo.ts`, `copilot-context.ts`, `copilot-tool-access.ts`, `types.ts` (`ClientIntegration`, `Asset`).
**Not read this session — confirm before implementing:** the actual React component(s) that render `Recommendation[]` today, if any exist. This RFC found the full data/type contract (`Recommendation`, `buildRecommendations`, `REC_COPY`, `approveSeoGeoRecommendation`) but did not locate or read a rendering component — do not assume one exists; verify at implementation time, and if none does, this RFC's §1 is the first thing to build, not a wiring exercise.

---

## 1. What the portal needs to add, concretely

RFC-09 designed the actuator; this is the karosCMO-side wiring so a client (or a staff member on their behalf) can actually trigger it. Four real gaps, each mapped to existing portal patterns rather than new ones:

1. A UI control per `Recommendation`, keyed by `actionKind`, that does something real when clicked (today `approveSeoGeoRecommendation` only records an approval — nothing consumes it).
2. A **connect** flow for CMS platforms (WordPress/Shopify/Webflow), extending the existing Integrations surface.
3. A way for `one_click`/`review_approve`/`connect` actions to become real, portal-visible **job runs** — not a bespoke backend mutation invisible to the run history every other agent gets.
4. A delivery surface for the `guided_manual` kit (§7 of RFC-09) and its scoped chat (§8 of RFC-09).

## 2. The recommendation card, per `actionKind`

| `actionKind` | Control | What it does |
|---|---|---|
| `one_click` | "Approve & apply" | Calls `approveSeoGeoRecommendation(recId)` **and** creates the actuator job (§3) in one step — but only after showing the diff preview from RFC-09 §3. Never skip the preview because the label says "one click." |
| `review_approve` | "Approve" → then a review step | Same job-creation path, but the job's result lands as `pending_review` (mirroring exactly the state every other draft-first agent in this codebase uses — Reputation Agent's `hold_for_approval`, Instagram/Carousel's disabled-until-QA state) before anything is applied. |
| `connect` | "Connect [platform]" if not yet connected, else "Approve" | Routes to the connect flow (§4) first; once `ClientIntegration` exists for that platform, behaves like `review_approve`. |
| `guided_manual` | "Get the implementation kit" + "Ask AI Architect" | Generates the RFC-09 §7 artifact and opens the scoped chat (RFC-09 §8) — no approval gate needed, since nothing executes on our side. |

This table is a direct extension of the `ownerFor()` copy already in `seo-geo.ts` (§3 of RFC-09) — the UI should read `actionKind` from the same `Recommendation` object the client already sees, not introduce a second classification.

## 3. Execution must be a real job, not a hidden mutation

Every other migrated agent in this document set gets a real run record with per-step telemetry (RFC-01 §7's `DynamicAgentRunReport`/`DynamicAgentRunStep`). The actuator must not be the one exception. When a client clicks "Approve & apply" (or a staff member approves a `review_approve` item), create a real Dynamic Agent Studio job — a new, small `DynamicAgentSpec` ("SEO & GEO Fix Actuator") whose steps are exactly RFC-09 §4's path A/B/C branches — so the fix's progress, cost, and outcome are visible in the client's job history exactly like any other agent run, and so the existing `DynamicAgentRunReport` failure/telemetry machinery (RFC-01 §6) applies here too instead of a bespoke success/failure path nobody else's tooling can see.

## 4. The connect flow — extend the existing Integrations surface, do not build a new one

The Gmail connect flow already documented in `copilot-tool-access.ts` (`GMAIL_UNAVAILABLE_MESSAGE`: *"sign in with Google via the Login page (or Integrations tab)... you will be prompted to grant [access]"*) is the template. Add WordPress/Shopify/Webflow as new connectable platforms on the same Integrations tab: an application-password or scoped-API-token form (WordPress/Shopify do not use the same OAuth flow as Google, so the connect UI needs a credential-entry form for these, not a redirect — but the **storage** is identical: a new `ClientIntegration` row, `platform: "wordpress"`, credentials through the existing `token-cipher.ts` encryption). Reuse `integrationBelongsToCaller`'s attribution pattern so a `connect`-type recommendation only shows as connected to the person (or workspace) that actually granted it, exactly as Gmail already does.

## 5. Delivering the guided kit and its chat

- **The kit itself** (`AGENT_TASK.md`, RFC-09 §7) is a generated artifact — deliver it through the same mechanism the portal already uses for any other agent-produced file the client downloads (the existing `Asset`/deliverable type and its `assetTypeLabel` copy pattern seen in `copilot-context.ts` — add a new asset type rather than inventing a new download surface).
- **The scoped chat** ("Ask AI Architect") should open the **existing** `CopilotDock`/`StaffCopilotDock` component, not a new chat widget, with `buildCopilotSystemPrompt()` called with an extra context block for the one recommendation in question (RFC-09 §8). This means the existing role gate (`isStaffCopilotActor`), the existing client-tool allowlist (`CLIENT_SAFE_COPILOT_TOOLS`), and the existing chat-panel Markdown-subset rendering rule all apply automatically — none of that hardening needs to be re-earned for this feature.

## 6. Data model additions — minimal, additive, matching this codebase's own conventions

- `ClientIntegration.platform`: add `"wordpress" | "shopify" | "webflow"` (and any others §4 needs) to whatever enum/union currently constrains it.
- A client-visible **status** per recommendation once a job exists — `not_started | pending_review | applied | failed` — most naturally as a field alongside `artifactRef` on the stored `VisibilityGap`/`Recommendation` pair, or resolved from the actuator job's own record (RFC-01 §7's `DynamicAgentRunStep.status`) rather than duplicated. Prefer resolving it from the job record over adding a new mutable field, per this codebase's own repeated lesson (seen in RFC-04/RFC-05 and in `seo-geo.ts`'s own comments) that a second, independently-mutable copy of a status is a drift risk waiting to happen.
- No new "actions" table, no new approval system — `approvedRecIds` and the new job record are the whole state.

## 7. Security notes carried over from earlier findings this session

- CMS credentials, like every other secret in this codebase, must never be injected as plaintext Cloud Run env vars — the live leaked-secret finding from earlier in this project (RFC-01 §16.3) applies exactly as much to a new WordPress application password as it did to `ANTHROPIC_API_KEY`. Use the same encrypted-`ClientIntegration` + Secret Manager posture already established.
- The CMS write tool (`cms.applyFix`, RFC-09 §5) must resolve its credential server-side from `clientId` alone — never accept a token, endpoint, or platform argument from client-side code or from the model, consistent with RFC-01 §9.1's tenant-from-context rule.

## 8. Definition of done

(1) A recommendation card renders a real, working control per `actionKind` (§2), confirmed against whatever UI currently exists (or is built fresh, per this document's header note); (2) approving a `one_click`/`review_approve`/`connect` recommendation creates a real, visible Dynamic Agent Studio job, not a silent mutation; (3) WordPress/Shopify/Webflow connect through the existing Integrations tab and `ClientIntegration` storage, with no new credential system; (4) the guided-kit artifact downloads through the existing deliverable/asset surface, and its chat opens the existing copilot component scoped to one recommendation; (5) one real client's `one_click` fix (starting with the lowest-risk `search.requestIndexing` actuator per RFC-09 §9) goes end-to-end — approve, preview, apply, visible in job history — before `cms.applyFix` is attempted on any client's live site.
