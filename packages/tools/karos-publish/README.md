# @agent-engine/tool-karos-publish

Capability-scoped, draft-first publishing. See section 9.2 / 9.2.1.

**Record-keeping implemented; posting not built yet — and that is a decision, not a gap.**
`publish.draft`/`publish.schedule`/`publish.status` are real, tested, idempotent JSON-record
tools (this package). Until SCRUM-295 (2026-08-28), nothing in `agents/`, `apps/`, or `evals/`
called any of them — `publish.renderCarousel` (a rendering tool, not a publish one) was the
only live export.

Tomer's decision record (SCRUM-333, decision 16, 2026-08-28): **real publishing is being
built** — a global auto-publish toggle plus per-post manual control, executing only for
channels where the client has completed a full platform integration. `draft`/`schedule`/
`status` are the record-keeping layer that feature needs and already exist; the per-platform
publish adapters (X/LinkedIn/Instagram/Reddit) and the toggle/gating logic itself are the
still-missing halves, tracked as follow-up work, not as part of this package today. See
[`docs/RFC-01-agent-engine-core.md`](../../../docs/RFC-01-agent-engine-core.md) §9.2.1 for the
full audit disposition.
