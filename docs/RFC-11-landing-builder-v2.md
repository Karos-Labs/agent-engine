# RFC-11: Landing Builder v2 — a real page, published

**Supersedes:** RFC-07's migration of the template-kit engine (`landing-builder-agent` v1). The product id, the portal mapping (`landing_page` → `landing-builder-agent`, deliverable kind `landing-page-site`) and the human gate kind (`landing_craft_review`) are unchanged; everything behind them is replaced.
**Status:** implemented on branch `feat/landing-builder-v2` (2026-09-05); first real client run pending the IAM grant in §8.

---

## 1. Why v1 was replaced rather than fixed

The run that prompted this (`jobs/Y8WAOF8qxd2yIKGBWD5h`, engine run `pubsub-20278561164758043`) stopped at `01c-enforce-context-doc-policy` with "missing required context doc(s) [product-information]". Karos Labs HAS that document in the portal, and the workspace mirror (`knowledge/context-docs.json`) carried it; only the projection path `context/product-information.json` was empty, because its writer never shipped and the engine-side fallback (`client.getContextDoc` 1.1.0) sat unmerged on a feature branch. A one-line fix would have let the run continue, into a product with four deeper problems:

1. **Nobody could see the result.** v1 produced an unbuilt Next.js source tree, uploaded file-by-file to GCS. The portal asset read "Site source (28 files) uploaded to gs://...". No preview, no URL, no screenshot. The render check never ran on any real deployment because it needed an already-running dev server that no container had.
2. **A fixed template decided the page.** Nine taxonomy sections, one FORGE-proven kit, per-client re-skin of tokens and fonts. Every client got the same page in different colours; the "not boring" bar was asserted in a prompt and unenforceable.
3. **It knew nothing the portal knows.** Intake required a hand-seeded `landing/brand.json` + `intake.json` per client. Karos Labs' copy named Inter Tight and `#141210` while the portal's brand kit said Space Grotesk and `#1a1a1a`. The client's six context documents, brand kit, and current website were never read.
4. **Copy and craft were Sonnet-tier and source-blind.** No old-site capture, no carry-forward inventory beyond what a human typed, no sourced-numbers discipline on the most public artefact this engine produces.

## 2. What v2 is

One self-contained `index.html` per client, decided by an Opus blueprint from everything the engine already knows about the client, built by Gemini 3.1 Pro, held to a deterministic floor and a headless render, judged once for craft, fixed once if needed, previewed on a real URL for the reviewer, and promoted to a live URL on approval. Rebuilds are revisions of the published state, driven by the run's free-text direction.

```
00 intake ──► 01 context docs ──► 02 capture current site ──► 02b grounding policy
     │
     ▼
03 BLUEPRINT (Opus)        every design + copy decision, structured; sourcedFacts[], bannedPhrases[]
     ▼
04 BUILD (Gemini 3.1 Pro)  css + one html fragment per section + script (PageParts)
     ▼
05 assemble ──► 06 checkPage ──► 07 renderPage (Chromium, screenshots) ──► 08 craft verdict (Opus)
     │ any failure
     ▼
09 FIX (one pass) ──► 05–08 again ──► still failing ⇒ needs_human (still delivered)
     ▼
10 archive to GCS ──► 11 Hosting preview channel ──► topic guardrail ──► 12 human gate
     ▼ approve
13 release the SAME version live ──► 14 write landing/state.json ──► 15 deliverable
```

### 2.1 Inputs (phase 0–2)
- `client.getProfile`, `client.getBrand`, `client.getVoiceRules`: what the portal projects for every client.
- Six context documents via `readContextDoc`: product-information, brand-voice, branding-guidelines, target-audience, market-strategy, competitor-analysis. Each best-effort.
- `landing.captureSite` (new): the client's current website, rendered in headless Chromium (already in the runtime image), yielding visible copy, headings, nav, CTAs, images, observed colours/fonts, third-party embeds, and desktop+mobile screenshots. Falls back to a plain fetch and says so.
- `landing.readIntake` (new): the OPTIONAL hand-curated `landing/brand.json` (brandLaw, typography bans, carryForward), `landing/intake.json`, and `landing/state.json` (the last published build). v1's two required files are now overrides.
- The portal brief: `page_goal`, `offer`, `sections`, `reference_urls`, the shared brief fields, and the run's free-text direction.

### 2.2 Grounding policy
`CONTEXT_DOC_POLICY`'s landing row stays BLOCK on product-information. v2 has a second source of published facts, the client's live site, so the block fires only when both are absent (`02b-grounding-policy`). A run grounded in the site alone records it in `assumptions[]`.

### 2.3 The blueprint (`PageBlueprint`)
Point of view, palette (brand kit is law), typography, motion mood, meta, primary CTA, 3–14 sections with FINAL copy and layout notes, carry-forward items with placements, declared assets (only URLs the sources carry), `sourcedFacts[]` (every figure the page states, verbatim from a source), `bannedPhrases[]`, the one signature moment, assumptions. Schema: `packages/tools/karos-landing/src/page/types.ts`.

### 2.4 The build (`PageParts`) and the assembler
`css` + `sections[{id, html}]` + `script`. `assemblePage()` owns the shell: `<html lang dir>`, viewport, title/description/OG/theme-color from the blueprint, the Google Fonts link for the blueprint's families, a skip link, `<header>`/`<main>`/`<footer>` landmarks in blueprint order. The model never writes the shell, so the shell is never wrong.

### 2.5 The gate, three layers
1. `landing.checkPage` (deterministic, string-level): one `<h1>`, `<main>`, title/description/viewport/lang, every blueprint section present by id, anchors resolve, primary CTA href present; every palette hex in the CSS; every font family used; no lorem/placeholder/template names, no banned phrases, the brand's glyph bans; **every figure sourced** (blueprint `sourcedFacts[]` or the corpus of context docs + captured site + brief); no external scripts/stylesheets except Google Fonts, no `@import`, images only from declared assets or the client's own domain; `alt` on images, text or `aria-label` on links/buttons. Returns the report as `success` even on failure so the fix step sees the violations.
2. `landing.renderPage` (Chromium, `page.setContent`): console errors, failed requests, horizontal overflow, opener luminance, `document.fonts` loaded, broken images, the lowest sampled text/background contrast (WCAG AA thresholds), page height, at 390×844 and 1440×900; full-page screenshots uploaded to the artifacts bucket with signed URLs.
3. `landing-craft-verdict@2` (Opus): brand + blueprint fidelity, the craft floor, the signature moment actually implemented, the first-pass bar; reads the HTML and the measured render facts (the router is text-only; screenshots go to the human).

One fix pass (`landing-fix@1`, same model as the build) receives the exact findings; the battery re-runs; a page still failing is delivered as `needs_human`, never dropped.

### 2.6 Publishing
`landing.uploadPage` archives `index.html`, `blueprint.json`, `parts.json` under `landing/<slug>/<runId>/` next to the screenshots. `landing.deployPage` publishes to Firebase Hosting (project `karoscmo`, one site per client `<prefix><slug>`, created on first use): a run-scoped preview channel with a 14-day TTL before the gate, and the same version released to `live` after approval, so what shipped is byte-for-byte what was reviewed. Both deploys are best-effort in the workflow: a Hosting failure is stated in the gate payload and the deliverable, and the signed GCS URL remains.

Why Firebase Hosting and not a public git repo + a static host: it is free at this scale, needs no token (the worker's own service account with two IAM roles), gives a URL per client and custom domains later, and keeps "what the reviewer saw" and "what went live" the same object. A git-push pipeline from a Cloud Run container would add a PAT in Secret Manager, a public repo per client, and a build hop for the same static file.

### 2.7 The human gate payload
`previewUrl`, `pageUrl` (signed), `images[{n,url}]` (the portal's existing slide renderer picks these up), `status`, `gate`, `craftVerdict`, `findings[]`, `assumptions[]`, `title`, `pov`, `signatureMoment`, `revision`.

### 2.8 Revision runs
`runKind === "recurring"` reads `landing/state.json`; the blueprint step receives the prior blueprint and the run direction as feedback and must keep untouched sections byte-identical; the build receives the prior parts. No prior state → builds fresh and says so. v1's feedback-round protocol (`FEEDBACK.md`, `classifyFeedbackRound`, structural deltas over a fixed taxonomy) is retired with the taxonomy.

## 3. Models
| step | model | why |
|---|---|---|
| landing-blueprint | `claude-opus-4-8`, pinned, `contentLanguageSensitive` | reads ~30k tokens of the client's own material and decides what the page says |
| landing-build / landing-fix | `gemini-3.1-pro-preview` on Vertex (`vendor: gemini`), pinned, `maxTokens` 60k | a whole front-end in one turn; served on Vertex in this project (verified reachable on `global`, 2026-09-05) |
| landing-craft-verdict | `claude-opus-4-8`, pinned | taste is the point |

`gemini-3.1-pro-preview` was added to `MODEL_CAPABILITIES` and `MODEL_PRICING` ($2 / $12 per 1M, ai.google.dev pricing page, 2026-09-05). Claude on Vertex still has zero quota in both projects; those steps fail over to the direct API key as every other Claude step does. Override per step with `MODEL_STEP_LANDING_BUILD_MODEL` / `_VENDOR` as usual.

## 4. Portal
`materializeLandingPageSite` now titles the asset with the page's `<title>`, leads the body with `Live:` / `Preview:` (or the signed page link without Hosting), rehosts the desktop screenshot as the asset cover, and carries `liveUrl`/`previewUrl`/`hostingVersion`/`craftVerdict`/`assumptions` in `meta`. A v1 deliverable still renders as before.

## 5. What was removed
`packages/tools/karos-landing`: the FORGE template kit and fixtures, `landing.copyTemplate`, `landing.writeSiteFile`/`readSiteFile`, `landing.gate` and its five checks, `landing.renderCheck`, `landing.readBundle`, `landing.updateBrandFeedback`, `landing.uploadSiteBundle`, site staging, the write sandbox, `LANDING_ENGINE_*_ROOT`. `agents/landing-builder-agent`: `feedback.ts`, `make.ts`, the compose/copy/make agents and prompts. `@agent-engine/dynamic-sandbox` is no longer a dependency of the landing tools.

## 6. Tests
- `packages/tools/karos-landing/__tests__`: assembler; every `checkPage` guard broken and refused; the Hosting client against a REST double (site create, populateFiles → upload → finalize → channel → release; hash dedupe; live re-release without re-upload; non-404 errors surfaced); `landing.deployPage` preview→live version reuse; `captureSite` fetch fallback; `renderPage` against real Chromium (skipped where none is installed; CI installs it) including overflow/near-black/console-error/low-contrast detection; intake/state round-trip.
- `agents/landing-builder-agent/__tests__/workflow-e2e.test.ts`: the full run with a fake router and a fake Hosting API (grounding in brand kit + docs + captured site; archive; preview; the same version live; state written; step ids); one fix pass then `needs_human`; craft-verdict fail → fix → pass; render failure → fix; no Hosting → completes with the archive; the gate payload when `autoApprove` is off; BLOCK only when both grounding sources are absent; degraded grounding recorded; revision with prior state and fresh build without.

## 7. Configuration
`LANDING_HOSTING_PROJECT` (=`karoscmo`), `LANDING_HOSTING_SITE_PREFIX` (`karos-prep-` on prep, `karos-` on prod), `LANDING_HOSTING_PREVIEW_TTL_SECONDS` (default 14 days). Wired in `cloudbuild.yaml` and `cloudbuild.promote.yaml`; documented in `.env.example`; in the capability catalogue as `landing-hosting`.

## 8. Operations still needed before the first live page
1. **IAM (blocked for the agent, needs a human):** on project `karoscmo`, grant both worker service accounts `roles/firebasehosting.admin` and `roles/serviceusage.serviceUsageConsumer`:
   ```
   gcloud projects add-iam-policy-binding karoscmo --member=serviceAccount:agent-engine-sa@karoscmo-prep.iam.gserviceaccount.com --role=roles/firebasehosting.admin
   gcloud projects add-iam-policy-binding karoscmo --member=serviceAccount:agent-engine-sa@karoscmo-prep.iam.gserviceaccount.com --role=roles/serviceusage.serviceUsageConsumer
   gcloud projects add-iam-policy-binding karoscmo --member=serviceAccount:agent-engine-sa@karoscmo.iam.gserviceaccount.com --role=roles/firebasehosting.admin
   gcloud projects add-iam-policy-binding karoscmo --member=serviceAccount:agent-engine-sa@karoscmo.iam.gserviceaccount.com --role=roles/serviceusage.serviceUsageConsumer
   ```
   Until then a run completes with the signed GCS URL and no `.web.app` preview.
2. Merge + deploy (prep auto-deploys from `main`); `scripts/publish-prompts.ts` runs in the deploy and publishes the four new prompts.
3. Custom domains per client are a Hosting console action (`Add custom domain` on the client's site); the engine does not automate DNS.
4. Firebase Hosting free tier: 10 GB stored, 360 MB/day served. One page per client is well under it; watch it if pages start carrying large images.

## 9. Known limits
- The craft verdict is text-only; the vision judgment is the human's. Extending `CompletionRequest` with image parts would let Opus see the screenshots.
- Images on the page are limited to declared assets and the client's own domain (plus inline SVG/data URIs). Stock or generated imagery (ENGINE-SPEC §13 option C) remains deliberately out of scope.
- One page per client per Hosting site. A second page (a campaign landing) would need a path or a second site; `landing.deployPage` currently ships `/index.html` only.
