# T-A5 — the fate of the two dead SEO/GEO config files

**Ticket:** SCRUM-233 · **Repo:** agent-engine · **Status:** decision doc, no production code changed.

Both files live in `packages/tools/karos-seo-geo/src/config/`. Neither is `import`ed by any
executable code path — confirmed by grepping every `.ts` file in the repo for each filename's
module specifier; the only hits are TSDoc/JSDoc comments and doc-string literals (below). They
are **not the same kind of dead**, and get two different recommendations.

| File | Verdict | Action |
|---|---|---|
| `routing-config.data.ts` (1081 lines) | Genuinely orphaned. Its formula prose has silently diverged from `recommend.ts`, the code that actually runs it. | **Delete**, after porting one still-correct detail (`excluded_but_fired_surfacing`, see §1.4) into a code comment. Zero migration cost — nothing imports it. |
| `connectors-config.data.ts` (286 lines) + `seo-geo-connectors-config-edits.txt` (41 lines) | Not abandoned — a fully designed, reviewed overlay feature gated on a named sign-off that hasn't happened. | **Keep both.** Do not delete, do not silently apply. Route to the sign-off owner named in §2.2. |

---

## 1. `routing-config.data.ts` — orphaned, and its formula has drifted

### 1.1 Confirmed dead

```
$ grep -rn "routing-config" --include="*.ts" . | grep -v node_modules | grep -v "config/routing-config.data.ts:"
./packages/tools/karos-seo-geo/src/recommend.ts:4:/** ... (`routing-config.json` `trigger.priority_formula`). */
./packages/tools/karos-seo-geo/src/recommend.ts:74: * ... ported verbatim from `seo-geo-routing-config.json` ...
./packages/tools/karos-seo-geo/__tests__/recommend.test.ts:4:describe("evaluateRecommendations (seo-geo-routing-config.json trigger.fires_when / priority_formula)", ...
```
Every reference is a comment citing the file as the *design source* `recommend.ts` was ported
from — never an `import`. `recommend.ts:1` imports only `recCatalogData` from
`./config/rec-catalog.data.js`; `routingConfigData` is not imported anywhere in the repo.

### 1.2 `trigger.fires_when` — matches exactly, no drift

`routing-config.data.ts:13`:
> `"per distinct rec_id, FIRE if min(norm across weighted input_weight>0 instances) < 1.0. Bands: norm>=1.0 pass (no action); 0.75<=norm<1.0 under_threshold/approaching (fires); norm<0.75 fail (fires). boolean/multi_bool: norm==1 pass else fail."`

`recommend.ts:56-63` (`classifyFireState`) and the `weight > 0` filter at `recommend.ts:91`
implement this verbatim, including the boolean/multi_bool override as a distinct branch, not a
restatement of the generic bands. `recommend.test.ts:4-33` pins all four cases (pass, approaching,
fail, boolean-override-fail-at-0.8, multi_bool-override-fail-at-0.75, boolean-pass-at-1) against
this exact prose. **No divergence.**

`score_lift` (`routing-config.data.ts:21`, `"(1 - norm) * input_weight"`) also matches
`recommend.ts:98` (`(1 - worst.norm) * worst.weight`) exactly. **No divergence.**

`CRITICAL_ELIGIBILITY_RECS` (`recommend.ts:5`: `BOTH-01, BOTH-02, GEO-01, GEO-08, GEO-10`) matches
the hard-override set named in `routing-config.data.ts:22` exactly. **No divergence.**

The `exclusions` block (`routing-config.data.ts:14-19`, visibility-index outcome metrics never
fire a calendar task) is not implemented inside `evaluateRecommendations` at all — and doesn't
need to be. It's enforced one layer up: `score-tool.ts:34-35` calls `evaluateScoreFamily`
separately for `SEO_BUCKETS` and `GEO_READINESS_BUCKETS` only (no Visibility family), and
`recommend-tool.ts:24` groups only `seoInputs`/`geoReadinessInputs` before calling
`evaluateRecommendations`. Visibility-family recs (GEO-11/12/26/27/32/35/36, BOTH-14) structurally
never reach the function. **No divergence — different layer, same effect.**

### 1.3 `priority_formula` — real divergence, code is right, config prose is self-contradictory

`routing-config.data.ts:22`:
> `"priority_score = 100*IMPACT_W*EFFORT_W + 20*(1-worst_norm) + 10*(fire_state=='fail') + 5*deliverability_bonus - 3*evidence_penalty; IMPACT_W{critical:4,high:3,medium:2,low:1}; EFFORT_W{quick:3,medium:2,heavy:1}; deliverability_bonus{agent_asset:2,product_trigger:1,gap:0}; evidence_penalty{VENDOR-correlational:1,else:0}. ..."`

`IMPACT_W` and `EFFORT_W` match `recommend.ts:7-8` exactly. But **`deliverability_bonus` is keyed
on `{agent_asset, product_trigger, gap}`** in the prose. `recommend.ts:9` instead keys it on
`{"agent-direct": 2, "existing-product": 1, "new-product": 0}` — a different vocabulary entirely.

This isn't a stylistic rename. `routing-config.data.ts` itself defines **two distinct enums**,
1031 lines apart, in the same file:

- `routing-config.data.ts:1053` (the planned `rec_actions` table schema): `delivery_class
  CHECK(agent-direct|existing-product|new-product)` — a column for the delivery mechanism.
- The same line: `action_kind CHECK(agent_asset|product_trigger|gap)` — a **separate** column for
  something else (action classification, not delivery mechanism).

The `priority_formula` string's `deliverability_bonus` is named for *delivery* but keyed with
`action_kind`'s enum values, not `delivery_class`'s. It has cross-wired its own two enums. Neither
`agent_asset`, `product_trigger`, nor `gap` appears anywhere as a `delivery` value in
`rec-catalog.data.ts` (verified: `grep -oP '"delivery":\s*"\K[^"]+' rec-catalog.data.ts | sort -u`
→ `advisory`, `agent-direct`, `existing-product`, `new-product`). `recommend.ts:101`
(`DELIVERABILITY_BONUS[catalogEntry.delivery] ?? 0`) reads `catalogEntry.delivery` straight from
`rec-catalog.data.ts` — the field that's actually populated — which only ever holds the
`delivery-class` vocabulary. **`recommend.ts` is right; the config's own prose is internally
inconsistent with its own schema three sections later.**

**Quantified, reproducible check** (run against `rec-catalog.data.ts`'s real 75 rows,
`dist/config/rec-catalog.data.js` build output, this session):

```
Distinct `delivery` values actually present in rec-catalog.data.ts:
  [ 'advisory', 'agent-direct', 'existing-product', 'new-product' ]
If deliverability_bonus were implemented using the config's own literal key names
(agent_asset/product_trigger/gap):
  -> every one of the 75 catalog rows falls through to the ?? 0 default: true
recommend.ts's actual keys instead score a nonzero bonus for 55 of 75 rows
(agent-direct=2 or existing-product=1).
```

This is the exact "check structurally incapable of passing" defect shape: had someone "fixed"
`recommend.ts` to match the config prose literally, `deliverability_bonus` would silently become
`0` for **100% of the catalog**, permanently, because the lookup keys can never match real data.
73% of recs (55/75) would lose their tiebreak bonus with no error, no test failure against
synthetic inputs, and no visible symptom beyond a subtly flattened priority queue in production.

**Existing test coverage**: `recommend.test.ts` (13/13 passing on `git rev-parse HEAD` at time of
writing, `dev-tomer` merge `bd6a780`) exercises `fires_when` behavior directly but does **not**
assert on `deliverability_bonus`/`priority_formula` numeric output — the divergence above was
found by direct code/config diff, not by a failing test. That gap is worth a follow-up ticket
(add a `priority_formula` regression test asserting nonzero bonuses for real catalog `delivery`
values), but is out of scope for T-A5's no-production-code-changed constraint.

### 1.4 One detail worth porting before deletion

`routing-config.data.ts:20` (`excluded_but_fired_surfacing`) documents a real product contract —
every excluded-but-fired rec still writes a `service_events` row so nothing silently disappears
from the portal timeline — that is **not** currently restated anywhere in `recommend.ts`'s own
comments. It's implemented by the caller (`a3-trigger-router`, not yet built per
`routing-config.data.ts:9-12`), not by `evaluateRecommendations` itself, so there's no code
divergence to flag — but the requirement itself is worth carrying forward into whichever ticket
builds `a3-trigger-router`, since it will otherwise disappear along with the file.

### 1.5 Supplementary finding: `routing[].delivery` vs `rec-catalog.data.ts[].delivery` also disagree

Not part of the `fires_when`/`priority_formula` ask, but found while reconciling the two dead
files against the one live file: `routing-config.data.ts`'s own `routing[]` array (75 rows, one
per `rec_id`) carries a `delivery` field that disagrees with `rec-catalog.data.ts`'s `delivery`
field for **11 of 75 rec_ids** (`BOTH-08, GEO-13, GEO-14, GEO-19, GEO-31, GEO-32, GEO-06, GEO-05,
GEO-33, GEO-15, GEO-25`), and five of those (`BOTH-08, GEO-13, GEO-14, GEO-19, GEO-32`) use
compound values like `"existing-product+new-product"` that don't exist in `rec-catalog.data.ts`'s
vocabulary at all. Since `recommend.ts` never reads `routing-config.data.ts` in any form, this
has zero production effect today — it's cited here only as further evidence that
`routing-config.data.ts` is not just unread but has been drifting internally for some time, which
strengthens rather than weakens the delete recommendation.

### 1.6 A third reconciliation may still be needed (AU27)

`docs/AUDIT-2026-08-25-architecture-optimization-plan.md:232`: *"The agent-engine rec-catalog port
predates v2 — diff and reconcile."* The legacy `karos-agents` v2 skill's Python scoring engine
(`assets/engine/score.py`, `recommend.py`) is the audit's named domain-logic source of truth for
this scoring domain, and it was not available in this clone (external repo, not vendored here — no
`karos-agents` checkout found on this machine) so it could not be diffed in this session. If AU27
lands and the v2 skill's `recommend.py` disagrees with `recommend.ts` on firing bands or the
priority formula, that supersedes this doc's §1.2-1.3 findings; **this section should be revisited
against `recommend.py` once AU27 is scoped**, since a config file that's dead today could still be
partially right about a rule that `recommend.ts` itself hasn't reconciled against the v2 skill.

### 1.7 Migration cost and risk of deleting

- **Cost:** trivial. Zero importers to update. Two comment references in `recommend.ts` (lines 4,
  74) and one `describe()` string in `recommend.test.ts` (line 4) cite the filename in prose only
  and don't need to change, though updating them to point at `recommend.ts`'s own JSDoc as the
  new source of truth is a reasonable one-line cleanup.
- **What breaks if the call is wrong (delete when it shouldn't have been):** nothing runtime —
  the file has zero readers. The only loss is historical/design context, which is fully preserved
  in the JSDoc `recommend.ts` already carries (it quotes the same prose inline, correctly) and in
  git history.
- **What breaks if the call is wrong (keep it, someone later trusts it):** the deliverability_bonus
  defect in §1.3, or a routing/delivery mismatch from §1.5, gets implemented as "the config says
  so" without re-checking against `rec-catalog.data.ts` or `recommend.ts`'s tests first.

**Recommendation:** delete `routing-config.data.ts` in a follow-up code PR (not this branch). It
is fully superseded by `recommend.ts` + `recommend.test.ts`, and its remaining unique value (the
`excluded_but_fired_surfacing` contract, §1.4) belongs in the future `a3-trigger-router`'s design
notes, not in a file nothing reads.

---

## 2. `connectors-config.data.ts` + `seo-geo-connectors-config-edits.txt` — not abandoned

### 2.1 Confirmed not imported, but actively referenced

No `.ts` file `import`s `connectors-config.data.ts`. The nearest thing to a consumer is
`agents/seo-geo-agent/src/workflow/connector-overlay.ts:13`, which explicitly documents why it
*isn't* a deep import:

> `"Mirrors seo-geo-connectors-config.json's (karos-seo-geo/src/config/connectors-config.data.ts)
> connectors[].key list — not deep-imported since that file isn't part of the package's public API
> (see karos-seo-geo/src/index.ts's export list)."`

That is: the four-connector list (`gsc`, `ga4`, `crux`, `gbp`) is hand-duplicated in
`connector-overlay.ts` rather than imported, by deliberate design choice (public-API boundary), not
neglect. `connector-overlay.ts:29,48,51` and two golden/gated tests
(`agents/seo-geo-agent/__tests__/gated-decisions.test.ts:63-66`,
`agents/seo-geo-agent/evals/seo-geo-golden.test.ts:46-51`) all assert the current agent output
correctly reports the edits file as `GATED` and **not applied** — this is a live, tested,
deliberate "pending" state, not dead code sitting unused.

### 2.2 The named sign-off owner

The ticket asks the decision doc to name who signs off on applying the gated overlay. The
codebase consistently names one person, first-name-only, in five independent files:

- `connectors-config.data.ts:205,225,226,281,282` — "GATED on Daniel's sign-off" / "remains
  Daniel's" (the sentinel-collapse digest rule and the N vs N_e denominator decision).
- `packages/tools/karos-seo-geo/src/config/capture-config.data.ts:224,254,259` — "BLOCKING, for
  Daniel" / "Daniel's pure-function scorer" / "GATED on Daniel's determinism sign-off."
- `packages/tools/karos-seo-geo/src/config/scoring-config.data.ts:848` — same "gated_on_daniel"
  key, identical text to `capture-config.data.ts:259`.
- `agents/seo-geo-agent/src/workflow/connector-overlay.ts:32,51` and
  `create-seo-geo-agent-workflow.ts:461,597` — "GATED on Daniel's determinism sign-off" /
  `blockingOn: "Daniel — N vs N_e visibility denominator choice (RFC-04 §4)"`.
- `docs/RFC-04-migration-seo-geo-agent.md:38-39,60` and
  `docs/PLAN-2026-08-status-and-roadmap.md:31,43` — "GATED on Daniel's determinism sign-off,
  deliberately NOT applied" / "Get the actual decision-maker (Daniel, per the code's own comment)
  to sign off on it explicitly."

**No surname or Jira/Slack handle for this "Daniel" appears anywhere in the repository.** (A
"Daniel Herbert" does appear in `linkedin-agent`/`setup-agents`, but only as a fictional client
seat name used in test fixtures — unrelated; nothing ties that name to this sign-off role.) The
strongest citable answer this doc can give is: **the sign-off owner is "Daniel," consistently
named across five files by two independent authors' worth of comments spanning capture, scoring,
connector, and RFC docs — but resolving that to an actual person (email/Slack handle) is a manual
step for Tomer**, not something derivable from the code.

Two separate things are gated on Daniel, and they are not the same decision:
1. **Applying the overlay itself** — folding `seo-geo-connectors-config-edits.txt`'s three edits
   (`google_overlay` block, `hash_inputs` 12→16 append, the sentinel-collapse digest rule) into
   the live `scoring-config.data.ts`/`capture-config.data.ts`/`metrics-config.data.ts`.
2. **N vs N_e** (`capture-config.data.ts:224`) — an orthogonal, separately-gated scoring-model
   decision the connectors-config file explicitly disclaims ownership of
   (`connectors-config.data.ts:282`: "remains Daniel's").

T-A6 (per the ticket) implements against whatever #1 decides; #2 is out of scope for T-A6 and
should not be bundled into the same sign-off request.

### 2.3 Migration cost if the overlay is approved

`seo-geo-connectors-config-edits.txt` is itself the migration plan, and is specific enough to
scope directly:
- 3 config edits (additive only — no weight/bucket/band/normalization change to any validated
  score, per the file's own "WHY" lines at 13, 23, 35).
- 1 new zero-anon Postgres table, `client_google_tokens`
  (`connectors-config.data.ts:257`), RLS-enabled, service-role-only.
- 1 new secret, `GOOGLE_CLIENT_TOKEN_ENC_KEY` (`connectors-config.data.ts:257,263`), env-only,
  never a DB column — this also needs an AU50-style production-parity ledger row once wired (new
  secret across prep/prod, IAM binding for the runtime SA) per the standing production-parity rule.
  Note: `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` are already provisioned (`connectors-config.data.ts:263`).
- A determinism-contract change to `hash_inputs` (12→16 fields), gated specifically because it can
  break reproducibility of frozen digests unless the sentinel-collapse rule ships in the same
  change (`connectors-config.data.ts:225-226`).

This is a real, multi-day feature, not a config toggle — consistent with the ticket's framing that
it's "awaiting sign-off and wiring," not "dead."

### 2.4 What breaks if the call is wrong

- **Applied without Daniel's sign-off:** the `hash_inputs` append is explicitly flagged as a
  determinism-contract change (`connectors-config.data.ts:205,225,226`) — done without the
  sentinel-collapse rule shipping in the same change, it silently breaks reproducibility of every
  existing frozen `inputs_digest`, which RFC-04 (`docs/RFC-04-migration-seo-geo-agent.md:60`)
  treats as non-negotiable golden-run behavior.
- **Deleted or left to bit-rot as "dead config":** loses a fully designed, tested (via the gated
  decision tests), reviewed feature spec for four real Google connectors (GSC/GA4/CrUX/GBP),
  forcing T-A6 to redesign from zero. This is exactly the mistake the ticket's "UPDATED 26 Aug"
  note exists to prevent.

**Recommendation:** keep both files as-is. Do not fold `seo-geo-connectors-config-edits.txt`'s
edits into the live scoring/capture/metrics configs without an explicit commit message or PR
description citing Daniel's sign-off by name/handle (once Tomer resolves who that is). T-A6
implements against the edits file once sign-off lands; until then this remains a correctly-gated,
correctly-undelivered feature, not dead code.

---

## 3. Summary for whoever picks up T-A6 or the routing-config deletion

| Question | Answer |
|---|---|
| Is `routing-config.data.ts` dead? | Yes, zero importers, confirmed by grep. |
| Should it be deleted? | Yes, in a follow-up code PR — this ticket changes no production code. |
| Does its formula match `recommend.ts`? | `fires_when`/`score_lift`/hard-override set: yes, exactly. `priority_formula`'s `deliverability_bonus`: no — the config's own prose keys it on the wrong one of its own two enums (`action_kind` instead of `delivery_class`); `recommend.ts` is right. |
| Is `connectors-config.data.ts` dead? | No — not imported, but actively referenced, tested (gated-state assertions), and design-complete. |
| Who signs off on applying it? | "Daniel" — named consistently across 5 files, no surname/handle in repo; Tomer needs to resolve the identity. |
| Does T-A5 change any production code? | No. |
