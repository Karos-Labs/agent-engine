<!--
  Moved into agent-engine on 2026-09-02 (SCRUM-234 close-out, Batch 15 Track C).

  It was written on 2026-09-01 as a loose handoff file in
  `batch-12-15-plan-2026-09-01/`, which is not a tracked repo. The batch plan's
  own reason for closing SCRUM-234 was that "a finding that lives only in a
  ledger part is one archived document away from being lost" — that applied to
  this file too, so it lives here now, beside the decision it produced.

  READ THIS ALONGSIDE `SCRUM-396-visibility-engine-list.md`, which is the
  finding that came out of this pass and which CORRECTS one inference below.

  This document is accurate on the evidence it gathered and careful about its
  own scope ("reconciling it is a product/architecture decision ... not
  something to silently correct here" — which was the right call). But its
  §"One real misreading" describes the Claude column as "explicitly deferred
  and currently unbuildable ('this provider has no Claude endpoint')", and
  warns against "building a Claude adapter" on that basis. Two things qualify
  that, both established while implementing SCRUM-396:

    1. "Unbuildable" is v2's constraint, not agent-engine's. v2 routes six of
       seven columns through one provider that has no Claude endpoint.
       agent-engine does not use that provider: it measures Claude first-party
       via `capture-adapters/claude.ts` (Anthropic Messages + `web_search`,
       Haiku-class capture), built to T-A3/SCRUM-237. The adapter this document
       warns against building ALREADY EXISTS AND WORKS.

    2. The three-list table below reads v2's list as six engines. v2's machine
       truth (`assets/config/seo-geo-v2-capture-config.json`) has SEVEN, with
       `claude` at `enabled_by_default: false` and `status: "FUTURE ADD-ON,
       deliberately not built (Albert, 2026-08-19)"`. Six is what you get by
       filtering on `enabled_by_default: true`. This document's own wording —
       "deferred as a documented future add-on" — is right; SCRUM-396's ticket
       write-up turned that into a removal, and recommended dropping a working
       measured column on the strength of it.

  So: the correction this pass found is real and was worth filing. The engine
  list is now seven accepted / five captured, and `claude` is kept.
-->

# SCRUM-234 — confirming the 2026-08-25 audit's §4c against the actual `karos-agents` checkout

**Status: In Progress (read-only confirmation pass — no code changed).** Performed via the device
bridge against `C:\Users\1\Documents\KarosLabs\karos-agents` on Albert's linked computer (this
environment has no direct access to `Karos-Labs/karos-agents` — confirmed 403 again this round,
consistent with every prior round). No `device_bash` tool was available on this desktop this round,
so the pass was read/list/stage-and-read only — sufficient for a claim-by-claim confirmation, not
sufficient to run `selftest.py` or any other executable check.

Audit reference: `agent-engine/docs/AUDIT-2026-08-25-architecture-optimization-plan.md` §4c
("SEO/GEO: ingestion architecture evaluation & legacy-v2 extraction").

## Claims confirmed as written

| # | §4c claim | Checked against | Result |
|---|---|---|---|
| 1 | Legacy v2 skill exists at `karos-agents/products/building/seo-geo-agent-v2/` | Directory listing | **Confirmed.** Full skill present: `SKILL.md`, `docs/`, `assets/`, `manager/`, `references/`, `setup/`. |
| 2 | `docs/SEO-GEO-V2-CAPTURE-CONTRACT.md` + `assets/config/scrappycoco-routes.json` encode the ingestion verdict | File listing + read | **Confirmed.** Both exist (19,226 and 13,857 bytes). |
| 3 | Proven end-to-end on a real client: `clients/karoslabs/outputs/seo-geo-agent-v2/2026-08-20-full-cycle-001/` | Recursive listing + read of `internal/15-close.md`, `internal/07-capture.md` | **Confirmed, and more precisely than the audit states** — see below. |
| 4 | "116 graded observations" | `internal/07-capture.md` | **Confirmed exactly.** "Dispositions after extraction: MEASURED_routed: 116" — 20 questions × 6 assistants × 1 repetition = 120 attempts; 119 captured, 1 timeout; 3 further excluded as `NO_ANSWER_SURFACE` (Google AI Overview absent for 3 prompts) and 1 as `UNAVAILABLE` (the timeout) — leaving exactly 116 cells that "carry a denominator." |
| 5 | "$0.63 measured cost" | `internal/15-close.md`'s cost-reconciliation table | **Confirmed exactly.** Total measured: **$0.631960**, against a pre-run estimate of ~$0.65. Every row is described as "a real provider charge read off the response," not estimated. |
| 6 | `assets/engine/` contains `score.py`, `visibility.py`, `recommend.py`, `citations.py`, a large `selftest.py`, and real-provider fixtures for 6 engines | Directory listing + `selftest.py` read | **Confirmed**, all five named files present, plus `facts.py`, `psl.py`, `render_report.py` (not claimed, not contradicted). Fixtures cover exactly 6 engines: `aimode`, `chatgpt` (×2 fixture files), `copilot`, `gemini`, `perplexity`, `google-aioverview`. |
| 7 | "132-assertion `selftest.py`" | Read of `selftest.py` | **Not exact, not concerning.** The file uses custom `check()`/`check_true()` helpers, not raw `assert` — counting calls to either gives **265**, not 132. The suite is real and substantial either way (far more so than 132 would suggest); the discrepancy most likely reflects the file having grown since whatever count the audit's "132" was drawn from, or a different counting method. Not a misreading worth acting on — flagged here only for completeness. |
| 8 | "Known vs Found, never blended," retired 2026-08-20, resolves the N vs N_e denominator with per-engine=N_e / blended=N, both always printed | `internal/15-close.md` | **Confirmed, live in the actual captured run**, and it is the same run dated 2026-08-20: "Known 75% ... Found 0% ... Never averaged. A blended index over the same cells reads about 15, which is the number the retired model would have published." This is exactly what AU28/SCRUM-319 already ported into agent-engine as `VISIBILITY_DENOMINATOR_DECISION` (confirmed independently this round while doing SCRUM-390 — see that ticket's commit). |

## One real misreading, worth acting on

**§4c's per-engine method table lists "Claude" as a currently live, first-party MEASURED engine
(`Anthropic Messages + web_search server tool ... ~$0.012–0.02/query`). That is no longer true of
the v2 skill, and the audit is citing a section the v2 skill's own current authority explicitly
marks superseded.**

`docs/SEO-GEO-V2-CAPTURE-CONTRACT.md` opens with: *"a great deal [changed]. Read
`references/capture-contract.md` FIRST, which is the current authority... In short: ... the engine
list is now **chatgpt, perplexity, gemini, copilot, aimode and google_aio, with the Claude column
deferred as a documented future add-on.** Sections below describing the old first-party-per-engine
capture methods are HISTORY."* The Claude row the audit quotes (line 49 of that same file) is inside
those HISTORY sections.

`references/capture-contract.md` — the document that file names as the actual current authority —
confirms it explicitly and names who decided it: *"The Claude column is a **deferred future add-on**
(Albert, 2026-08-19). v1 measured it first-party and this provider has no Claude endpoint."*

The real captured run corroborates this as the operating reality, not just a stated intent: the
120-attempt run at `2026-08-20-full-cycle-001` — one day after that decision — used exactly 6
engines (`chatgpt`, `perplexity`, `gemini`, `copilot`, `aimode`, `google_aio`), and there is no
`claude` engine anywhere in its 119 raw answer files.

**And this is not a stale-audit-only problem — agent-engine's own shipped code already disagrees
with the v2 skill's current, decided engine list, in the other direction from the audit.**
`packages/tools/karos-seo-geo/src/types.ts`:

```ts
export const SEO_GEO_VISIBILITY_ENGINES = ["chatgpt", "perplexity", "gemini", "claude", "copilot"] as const;
```

Five engines, including `claude`, excluding `aimode` and `google_aio` — a third, different list from
both the audit's table and the v2 skill's actual current 6-engine list. So there are three lists in
play right now:

| Source | Engines |
|---|---|
| agent-engine, shipped (`SEO_GEO_VISIBILITY_ENGINES`) | chatgpt, perplexity, gemini, **claude**, copilot |
| v2 skill, current decision (2026-08-19, Albert) | chatgpt, perplexity, gemini, copilot, **aimode, google_aio** |
| Audit §4c's per-engine table | chatgpt, perplexity, gemini, **claude**, copilot (implicitly, via the HISTORY section) |

**Why this matters for anyone building `research.captureVisibility`'s real adapters** (§4c's own
next recommendation, and Batch 15+ territory): building against the audit's table as written would
mean building a Claude adapter the v2 skill's own current authority says is explicitly deferred and
currently unbuildable ("this provider has no Claude endpoint"), while NOT building `aimode` and
`google_aio` adapters, which are two of the six engines the only proven, real, $0.63-measured run
actually used. The audit's own instruction — "adopt this per-engine adapter matrix as the
implementation spec... do not re-derive the first-party API decisions" — is right in spirit, but the
matrix it quotes to satisfy that instruction is the superseded one. The v2 skill's current
`references/capture-contract.md` is the one to build against, not §4c's table nor agent-engine's
existing `SEO_GEO_VISIBILITY_ENGINES` constant.

**Recommendation, not actioned here** (out of SCRUM-234's read-only scope): flag this to Tomer before
any `research.captureVisibility` real-adapter work starts, since it would otherwise be the second
instance this programme has hit of "built against a document's text instead of its current state"
(the same class of mistake SCRUM-387 exists because of, and the same warning Batch AFTER-BLOCKERS'
SCRUM-243 spec repeats about S-A15). `SEO_GEO_VISIBILITY_ENGINES`'s inclusion of `claude` should
itself be re-examined against the current 6-engine decision when that work is scheduled — but
reconciling it is a product/architecture decision for whoever picks up the adapter work, not
something to silently correct here.

## Conclusion

§4c is substantively accurate and the underlying legacy-v2 asset is real, proven, and exactly as
capable as claimed — the $0.63/116-observation run, the Known/Found retirement, and the
extractable scoring engine all check out precisely against the actual checkout. The one claim that
does not hold as written is the per-engine capture-method table's inclusion of Claude as a currently
live MEASURED engine; that section of the v2 skill it's quoting is itself marked HISTORY by the v2
skill's own current documentation. Closing this ticket as **superseded/confirmed-with-one-correction**
rather than a clean pass, so the Claude-engine discrepancy doesn't get silently lost.
