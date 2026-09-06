# SCRUM-396 — which AI-visibility engines the list contains

Status: **Ratified and implemented, 2026-09-02.** No product decision was needed:
the decision already existed, dated and owned, and the ticket had misread it.
This document records what the evidence actually says, because the ticket's own
recommendation would have removed a working capability.

## What the ticket asked

Four lists of AI-visibility engines disagreed. The ticket named three, recommended
adopting the v2 skill's six — `chatgpt, perplexity, gemini, copilot, aimode,
google_aio` — and flagged that this meant **dropping `claude`**, on the strength of
the v2 contract's sentence *"this provider has no Claude endpoint."*

The batch plan was right to stop there. That sentence is about v2's routed
provider, not about Claude, and "the provider has no Claude endpoint" is not the
same claim as "Claude cannot be measured."

## What the evidence says

`claude` was never dropped. It is engine seven of seven in the v2 skill's own
machine truth, and the deferral is explicit:

```
key: claude
capture_method: first_party_api_web_search_tool
api: Anthropic Messages API with the web_search server tool
default_tier: MEASURED_first_party
enabled_by_default: false
status: FUTURE ADD-ON, deliberately not built (Albert, 2026-08-19)
opt_in_credential: ANTHROPIC_API_KEY
parity_note: ACCEPTED PARITY TRADE, recorded so it is never a surprise. v1 measured
  Claude first-party; the routed provider has no Claude endpoint. Rather than hold
  the build for it, the column is deferred: this entry documents the whole path so
  enabling it later is configuration plus one capture adapter, not a redesign.
```
— `karos-agents/products/building/seo-geo-agent-v2/assets/config/seo-geo-v2-capture-config.json`

Three independent sources agree, and none of them says "removed":

| Source | Says |
|---|---|
| `assets/config/seo-geo-v2-capture-config.json` | 7 engines; `claude.enabled_by_default: false`, `status: FUTURE ADD-ON` |
| `references/capture-contract.md` (the authority) | "The Claude column is a **deferred future add-on** (Albert, 2026-08-19) … enabling it later is configuration plus one adapter" |
| `docs/SEO-GEO-V2-CAPTURE-CONTRACT.md` HISTORY banner | "the engine list is now chatgpt, perplexity, gemini, copilot, aimode and google_aio, **with the Claude column deferred as a documented future add-on**" |

The six-engine reading is what you get by filtering that list on
`enabled_by_default: true` and losing the seventh row. `docs/PRODUCTION-PARITY-LEDGER.md`
Part 3, which is where this finding originated, said "Claude deferred" correctly;
the ticket wrote it up as a removal.

**And the deferral's reason does not apply to this repo.** v2 deferred Claude
because its routed provider has no Claude endpoint. agent-engine does not use that
provider: it measures Claude first-party through
`packages/tools/karos-research/src/capture-adapters/claude.ts`, against
`ANTHROPIC_API_KEY`, built to T-A3/SCRUM-237 and matching v1.1's costed spec
(`$10 per 1,000 searches + Haiku capture tokens ≈ $0.012–0.02/query`). Dropping
`claude` here would have deleted a working, costed, measured column to match a
constraint this repo does not have.

## The decision

**Seven engines accepted, five captured.**

- `SEO_GEO_VISIBILITY_ENGINES` — `chatgpt, perplexity, gemini, claude, copilot, aimode, google_aio`.
  What a stored cell may claim, and what `schemas.ts`'s `z.enum` accepts.
- `SEO_GEO_CAPTURE_ENGINES` — the subset with `captured: true`, derived from
  `SEO_GEO_VISIBILITY_ENGINE_SPECS`. What a run measures, and what
  `engineListHash` covers. Today: `chatgpt, perplexity, gemini, claude, copilot`.

`aimode` and `google_aio` are added to the accepted list and left out of the
fan-out, because **this build has no adapter for either.** Fanning out to an
adapter-less engine writes a full column of honest-but-empty
`UNAVAILABLE`/`no_adapter_wired` cells on every run: it measures nothing, and
because `UNAVAILABLE` cells are excluded from `N_e` it *lowers the coverage
percentage a client actually feels*. They join the fan-out by flipping `captured`
when the adapter lands — no schema change, no read-compat path, because the
schema already accepts them.

### Why additive-only, and why nothing broke

Both halves of the change are safe in the direction they move:

- **Widening the accepted list breaks no stored data.** Adding members to a
  `z.enum` cannot fail a read; only removing them can. Since `claude` is kept,
  there is no narrowing anywhere, so the "check no persisted cell claims
  `claude`" precondition never arises.
- **The captured list did not change, so `engineListHash` did not change.** The
  hash covers `SEO_GEO_CAPTURE_ENGINES`, which is byte-identical (same five keys,
  same order) to the constant it replaces. Every prior run's frozen record stays
  valid. **There is no version bump to make**, and the batch plan's concern that
  "every prior run's hash stops matching" does not materialise. A regression test
  pins the hash value so this stays true by assertion rather than by luck.

### The drift gap this closed on the way

Nothing recomputed `engineListHash` against the stored one, so a future change to
the captured list would have altered the response set with no record anywhere —
while the prompt set, the other half of the same reproducibility spine, has logged
its drift since RFC-04 §3/§4. `04-freeze-prompt-set` now records an
`engine_list_drift` decision on a recurring run whose captured list changed,
mirroring `prompt_set_drift` exactly, and freezes the list into beliefs in the
same `memory.updateBeliefs` diff as the prompt set. That is also what v2's capture
contract requires of a source change: *"a capture-config version bump … carries a
drift event."*

## What was rejected, and why

**Making the list environment-configurable** (the batch plan's "consider"). No.
The list feeds a `z.enum` that validates *persisted* cells, so an env-driven list
makes the stored-cell schema a function of the deployment: a cell written in prep
could fail validation on read in prod, and the reproducibility hash could change
without a commit. An engine list change should be a reviewable diff and a logged
drift event. It stays in code.

**Editing `capture-config.data.ts`'s values.** No. That file's header states it is
a byte-for-fidelity transcription, and its provenance is its entire value. It got
a HISTORY banner instead — naming `engines[]`, `hero_honesty`'s "across 5
engines", `ranking_report`'s "5th engine column" and
`measured_vs_estimated`'s tier roll-call as v1.1-vintage — which is exactly what
the v2 skill did to its own superseded doc.

## One correction to the batch plan's read

The plan expected `hero_honesty`'s "across 5 engines" to be a live client-facing
defect of the same class as SCRUM-390. **It is not, in this repo.** That string is
a design note inside the historical v1.1 transcription; nothing renders it, and
`grep` finds no rendered engine count anywhere in agent-engine — `17-assemble-report`
emits structured data with no hero copy at all.

The real instance of the defect is one repo over. The report carried **no engine
list whatsoever**, so anything rendering it had to supply its own count, and
karosCMO duly did: `src/lib/seo-geo.ts:611` documents an `"N of 5 engines"`
disclosure and `src/lib/agent-engine/seo-geo-deliverable-types.ts:43` keeps a
hand-copied five-key mirror of this very constant, pinned by a test asserting
"exactly the five engines". The portal's *arithmetic* is safe — `enginesTotal`
defaults to the data's own length — but its `KNOWN_ENGINE_IDS` boundary validator
would reject an `aimode` or `google_aio` cell outright.

So `17-assemble-report` now states `engines: { accepted, captured, decision }` on
the report, derived from the ratified constant, so a renderer reads the engine
count instead of hardcoding one. **The portal's mirror still needs widening** —
tracked as SCRUM-396's portal half; nothing emits the two new keys yet, so it is
not urgent, but it is the same drift this ticket exists to kill.

## How this is kept from drifting again

`agents/seo-geo-agent/__tests__/visibility-engine-list.test.ts` — the one workspace
that legitimately sees both tool packages (RFC-01 §4 keeps them independent of
each other). It asserts the sources derive from one constant rather than re-listing
the keys, and it fails if:

- `karos-research`'s `VISIBILITY_ENGINES` and `karos-seo-geo`'s
  `SEO_GEO_VISIBILITY_ENGINES` stop being equal;
- `schemas.ts`'s `z.enum` stops accepting any accepted engine, or starts accepting
  a non-engine;
- `SEO_GEO_CAPTURE_ENGINES` stops being a subset of the accepted list, or stops
  agreeing with `SEO_GEO_VISIBILITY_ENGINE_SPECS`;
- `engineListHash` changes value;
- the v1.1 config port's `engines[]` stops being a subset of the accepted list.

`SEO_GEO_VISIBILITY_ENGINE_SPECS` is a `Record<SeoGeoVisibilityEngine, …>`, so the
*typechecker* — not a test — refuses an engine with no spec and a spec with no
engine.

## 2026-09-05 addendum — Copilot leaves the fan-out

**Decision (product owner, 2026-09-05):** Microsoft Copilot is no longer
captured. It stays in the accepted vocabulary (`SEO_GEO_VISIBILITY_ENGINES`,
still seven) so every historical cell and frozen record parses, but
`SEO_GEO_VISIBILITY_ENGINE_SPECS.copilot.captured` is now `false`, so
`SEO_GEO_CAPTURE_ENGINES` is four engines: `chatgpt, perplexity, gemini, claude`.

**Why.** Copilot has no consumer API. The ScrappyCoco capability the adapter
once named does not exist on the account (52 capabilities, none an answer
engine), and the owner has said no other route will be added. Until now it
was kept in the fan-out so its column showed as an honest `UNAVAILABLE`
rather than vanishing; the owner's call is that a column that can never be
measured is noise in the coverage denominator, not honesty.

**What changes.** `engineListHash` moves from
`98881508eb5591f3f6b6d8db29bd12496f6e733c66512780e6d85ea3144b88dd` (five
engines, T-A3) to
`d0c4b2518a6626cf1e17dc75594da7294e12b5c845b1fc0eb4b31917e283e755` (four).
Every client's next recurring run logs this as engine-list drift via
`04-freeze-prompt-set`, exactly the mechanism this document said would fire
"the moment this list does change". Reverse by flipping `captured` back and
wiring an adapter; nothing else needs to move.
