# @agent-engine/tool-karos-memory

Structured, retrieved-not-loaded-whole instance memory. See section 9.2.

**Not implemented yet.** See the relevant section of [`docs/RFC-01-agent-engine-core.md`](../../../docs/RFC-01-agent-engine-core.md) for the spec this package implements.

## Decision memory is scoped by `(clientSlug, productId)`, not `clientSlug` alone

`memory.appendDecision` / `memory.read({scope:"decisions"})` store under
`clients/<clientSlug>/memory/products/<productId>/decisions/...`. Every channel
agent's own "load recent decisions" step (linkedin-agent's archetype rotation,
x-agent's lane rotation and engagement cap, blog/reddit/newsletter's topic
dedup) reads this back assuming it is that product's own history — keying by
`clientSlug` alone put every product for a client into one shared bucket, so a
multi-channel client's no-repeat rules silently degraded (AU24 / audit
§4.2-§4.3-3): a same-client, different-product decision with a later timestamp
could stand in for "the last post," defeating the rule while it still
*looked* enforced. `memory.read({scope:"beliefs"})` is deliberately left
client-wide — every channel agent reads the exact same beliefs scope today, so
that state is meant to be shared brand/tone learning across a client's whole
product line, not per-channel.

### Migration: existing pre-fix decision rows are not backfilled

Rows written before this fix live at the old, unscoped
`clients/<clientSlug>/memory/decisions/<decisionId>.json` path.
`AppendDecisionInputSchema`/`DecisionRecord` never carried a `productId`
field, so an old row does not itself say which product wrote it — the only
way to guess is to pattern-match its free-text `summary` (`"(archetype: ...)"`
for linkedin-agent, `"(lane: ...)"` for x-agent, and so on). That is rejected
as the migration path: per-agent regexes are exactly the fragile,
silently-wrong-if-a-format-changes mechanism this ticket exists to remove, and
several products' summaries (blog's `"(keyword: ..., angle: ...)"`, campaign-
orchestrator's `"Ran campaign ... across N channels"`) don't identify a single
product unambiguously even by inspection.

Old rows are left on disk untouched (nothing deletes them) but are no longer
read by `memory.read` — they are inert history, not migrated into any
product's bucket. The practical effect: the first run of each product after
this ships sees an empty decision log for itself (e.g. linkedin-agent's
`lastArchetype` comes back `undefined` for one run, same as a brand-new
client), then accumulates its own product-scoped history from that point on
normally. This is a one-time, visible reset, not a silent misattribution —
consistent with this fix's whole point being to stop the rule from *looking*
enforced when it isn't.
