# SCRUM-333 / AU50 — production parity ledger

**Standing ticket. Does not close.** Set by Tomer on 2026-08-26: a ticket reaching Prep (merged to
`main`, deployed to the prep project) is not the same claim as a ticket being live in production —
secrets, IAM bindings, `cloudbuild.promote.yaml` env/`--set-secrets`, cross-service config
agreement, and per-environment bucket/topic/subscription names are a second, separate checklist
that a green deploy does not verify. This ledger is where that second checklist lives, so a gap is
a row here instead of a surprise in production.

**This is the ledger's first committed version.** It has been carried as a standing ticket since
Batch 8 (2026-08-26) across every batch plan since, but no prior pass ever landed it as a document
in a repo — this pass does that for the first time, covering everything shipped through Batch 12.
It is deliberately not exhaustive per-ticket for every one of the ~50 tickets batches 1–12 have
shipped (that would need a dedicated follow-on pass reading every ticket's own production
footprint); it records what is actually known today, marks what is unknown as unknown rather than
leaving it blank, and gives the next pass a real structure to extend rather than a blank page.

Every row answers, or explicitly marks unknown, AU50's five production questions:

1. **Secrets** — exists in `karoscmo` (prod), not only the prep project?
2. **IAM** — does the runtime SA hold the binding it needs on that secret/bucket?
3. **`cloudbuild.promote.yaml`** — env vars / `--set-secrets` updated, per service (`deploy-http` and
   `deploy-worker` are separate surfaces).
4. **Cross-service config** — engine and portal's matching `AGENT_ENGINE_*`/equivalent variables
   agree, in the same environment.
5. **Buckets/topics/subscriptions** — named per environment; prod names are usually different from
   prep's.

## Part 1 — open parity rows with known owners (Pass 2 carried forward)

| Row | From | Q1 secret | Q2 IAM | Q3 cloudbuild | Q4 cross-service | Q5 naming | State |
|---|---|---|---|---|---|---|---|
| `PUBSUB_PUSH_TOKEN` unwired in both environments | SCRUM-288 | unknown | unknown | not updated | n/a | n/a | **Still open.** No batch through 12 has touched this. |
| Prep's portal authenticated with a **production** Firebase credential | SCRUM-359 (AU60) | n/a | n/a | n/a | n/a | n/a | **Resolved.** `karosCMO@1026122` ("AU60 (SCRUM-359) Q1") bound the Firestore database id to `GOOGLE_CLOUD_PROJECT` rather than the credential's own `project_id` — probed directly: prep writes land in `databases/prep`, read back NOT_FOUND in `(default)`. Prep does not write to production. Remaining: a dedicated prep-scoped Firebase Admin SA + key, and rotating the production key — those are the still-open parity work, not the incident risk itself. |
| Prep runtime SA has no binding on either prep bucket, media dead at request time | SCRUM-369 (AU69) | n/a | **Now IAM-plan-valid.** | unknown | n/a | n/a | **Q2 pre-condition landed, grant itself not confirmed applied.** SCRUM-373 (found independently, not on any batch doc — landed in both repos) migrated GCS clients from the shared `FIREBASE_SERVICE_ACCOUNT_KEY` credential to pure ADC, so GCS calls now genuinely run as the real per-environment SA (`karos-cmo-prep@karoscmo-prep.iam.gserviceaccount.com` / `karos-cmo-sa@karoscmo.iam.gserviceaccount.com`) instead of the shared prod identity — this is what makes AU69's IAM grant plan meaningful at all; before SCRUM-373 it would have been a no-op. Batch 11 (SCRUM-369) is "treated as done per instruction" per the closing plan, but this environment never independently verified the grant was actually applied in the console — **flag for a live check.** |
| Prod portal and prod engine name **different** media buckets | SCRUM-376 (AU74) | n/a | n/a | n/a | n/a | **Still undecided.** | Batch 11 (SCRUM-376) "treated as done at instruction" — briefing + execution packet delivered, bucket choice itself is a decision for whoever runs the console step, not resolved by this programme. |
| `karoscmo-agent-artifacts` — 12,011 objects / 7.96 GiB named by no variable on any running service | SCRUM-376 | n/a | n/a | n/a | n/a | **Uninventoried.** | Unchanged since Batch 8. No batch through 12 inventories or claims this bucket. |
| Most production Claude spend is invoiced by Anthropic and appears in no GCP report | SCRUM-375 (AU73) | n/a | n/a | n/a | n/a | n/a | **Org not identified.** Unchanged since Batch 8; Batch 11 (SCRUM-375) "treated as done at instruction" per the closing plan but this is an observation/runbook item, not a resolution of the underlying gap. |
| `UNIT_PRICING` has no row for `gemini-2.5-flash`, AU37's vision analysis records $0 | Batch 1/4 finding | n/a | n/a | n/a | n/a | n/a | **Resolved this batch (SCRUM-391, Batch 12).** Investigated which pricing shape was correct (token-based, off the existing `MODEL_PRICING["gemini-2.5-flash"]` row, not a new flat per-call `UNIT_PRICING` guess) and wired real captured token counts through it. Independently re-verified: `npx tsx scripts/check-model-pricing.ts` clean, adversarial-proof reproduced. The capability's cost reporting is no longer a $0 blind spot — this row can close. |
| SCRUM-232/T-A6's gated connector config not applied — needs three decisions, one from an unidentified "Daniel" | Batch 1/4 finding | n/a | n/a | n/a | n/a | n/a | **Still open, and now doubly parked.** SCRUM-390 (Batch 12) confirmed the same "Daniel" sign-off — no surname or handle for "Daniel" appears anywhere in either repository — separately blocks SCRUM-390's own N/N_e denominator field (resolved this round via AU28/SCRUM-319's data-based answer, so SCRUM-390 did not actually need Daniel) and still blocks SCRUM-232's gated config edit. Two independent pieces of work parked on one unidentified person — worth surfacing to Tomer directly as its own question, not folded into either ticket's diff. |

## Part 2 — Batch 11's five console/ops rows (each closes with an observation, not a deploy)

Per `BATCH-11-OPS-RUNBOOK.md` §7 (delivered in the Batch 10/11 handoff) and the closing plan's own
framing ("Batch 11's five console tickets are treated as done here at your instruction"). This
environment cannot independently verify any of these five (no GCP credentials/tooling of any kind,
confirmed repeatedly) — recorded here as the parity rows they are, each flagged with what
independent confirmation would need to check:

| Ticket | What it grants/observes | Independently confirmed by this programme? |
|---|---|---|
| SCRUM-331 | (console action — see runbook) | Not independently confirmed. Execution packet delivered; no live check performed. |
| SCRUM-359 (AU60) | Q1 Firestore-database-binding incident check | **Q1 answer independently corroborated this round** by reading the landed code and commit (see Part 1 row above) — the *code fix* is real and tested; whether it is *deployed and observed working in prep* has not been independently checked live. |
| SCRUM-369 (AU69) | IAM grant on prep bucket | Not independently confirmed the grant itself was applied — see Part 1 row. |
| SCRUM-375 (AU73) | Anthropic spend org identification | Not independently confirmed. |
| SCRUM-376 (AU74) | Prod bucket naming decision | Not independently confirmed — and the closing plan itself notes the bucket choice is still undecided. |

**Recommendation:** the one item worth a live re-check ahead of the others is SCRUM-359, per the
closing plan's own flag — its Q1 "may be an incident rather than a hygiene item and nothing
downstream will surface it" if the fix were not actually deployed to prep.

## Part 3 — systemic gaps found during independent verification, not yet ticketed as parity rows

- **`SEO_GEO_VISIBILITY_ENGINES`'s engine list disagrees with the v2 skill's own current, decided
  engine list** — found during SCRUM-234's confirmation pass this round (see
  `SCRUM-234-audit-4c-confirmation.md` in this same handoff). agent-engine ships `["chatgpt",
  "perplexity", "gemini", "claude", "copilot"]`; the v2 skill's current authority
  (`references/capture-contract.md`, decided 2026-08-19) is `chatgpt, perplexity, gemini, copilot,
  aimode, google_aio` — Claude deferred, `aimode`/`google_aio` live. Not a deploy-parity gap in
  AU50's five-question sense, but a real production-facing correctness risk for whoever builds
  `research.captureVisibility`'s real adapters (§4c's own next recommendation) — recorded here so
  it is not lost before that work is scheduled.
- **Batch 11's console tickets have no independent verification path from this environment at
  all** — worth naming as a standing constraint of this programme's ledger, not just a one-time
  note: every future console/IAM/Secret-Manager ticket will land in this same "treated as done at
  instruction, not independently confirmed" state unless a session with real GCP access performs a
  dedicated verification pass.

## Part 4 — what a complete Pass 1 (per-Prep-ticket) still needs

This version does not attempt a per-ticket Pass 1 across all ~50 tickets at Prep from batches 1–12
— that is real, dedicated work (an hour or more of reading each ticket's own production footprint)
and was not done here in favor of landing Parts 1–3, which carry higher-value, already-known gaps.
**Next pass should:** enumerate every ticket currently at Prep across both repos (a Jira export or
board read, not a guess), and for each one new since this ledger's last update, answer the five
questions above or mark them explicitly unknown. AU50 stays open — that is what a standing ticket
does.

## Sources

- `agent-engine/docs/AUDIT-2026-08-25-architecture-optimization-plan.md`
- `BATCH-8-HOUSEKEEPING-AND-LEDGER.md` (this ledger's original spec and the five-question framework)
- `karosCMO@1026122` (AU60/SCRUM-359's fix commit, read directly)
- `agent-engine`/`karosCMO` diffs for SCRUM-373 (GCS ADC migration), read directly
- This round's own SCRUM-390 (Batch 12) and SCRUM-234 (Batch 12) findings
- `BATCH-11-OPS-RUNBOOK.md` §7 (delivered Batch 10/11 handoff)
