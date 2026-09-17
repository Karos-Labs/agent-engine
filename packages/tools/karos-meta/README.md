# karos-meta

Meta Graph API connector: Instagram post/reel performance (`reach`, `views`,
`saved`, `shares`, `follows`, `profile_visits`) and follower count, plus an
internal, off-by-default path to publish an Instagram post
(`meta.publishInstagramPost`). Both use Karos Labs' own Business Manager
System User token.

## Why a System User token instead of per-client OAuth

`karosCMO` already has a per-client OAuth flow for Instagram/Facebook
(`src/lib/integrations/oauth.ts`), used for **publishing** on a client's own
behalf. This package is a separate, simpler mechanism for **reading**
performance data across every client at once: Karos Labs holds one
Business-Manager System User token, and each client grants it read access by
adding Karos Labs as a partner in their own Meta Business Settings — no
per-client OAuth popup, no per-client token to store or refresh.

## Publishing: internal-only, off by default, Instagram only

`meta.publishInstagramPost` posts a single image to a client's Instagram
account (create-container → poll → `media_publish`, in `publish.ts`), through
the same shared System User token and the same Business-Manager-partner grant
`instagram_insights` already reads under.

Three things are true about it at once:

- **Internal only.** There is no client-facing "Connect" button or OAuth
  popup for this anywhere — clients never see or trigger it. Only Karos Labs
  staff/agents call the tool.
- **Off unless explicitly enabled.** A second env gate, `META_PUBLISH_ENABLED`,
  sits alongside `META_SYSTEM_USER_TOKEN` (see `env.ts`). Configuring the
  token alone does NOT enable posting — a deployment that only wants reads
  can carry this code with the publish tool permanently inert. Both gates are
  checked before any network call; see `index.ts`'s `meta.publishInstagramPost`.
- **Instagram only — no Facebook Page post.** An Instagram professional
  account is only reachable through the Facebook Graph API (it's always
  linked via a Page), so Facebook is this package's TRANSPORT either way —
  but `publish.ts` has no function that posts directly to a client's Facebook
  Page feed. Adding one would make Facebook itself a product this package can
  push content to, which is exactly what "portal feedback round 2, 2026-09:
  we don't work with Facebook" (`platforms.ts`) took off the table. Confirmed
  with Albert 2026-09-16.

Video/Reels and carousel posts are not yet implemented — `publish.ts`'s
module header says why and what a follow-up needs.

## Two-tier degradation

- `not_available` — this deployment has no `META_SYSTEM_USER_TOKEN`
  configured (or it was configured but Meta hasn't approved the Advanced
  Access permissions yet — see `META_ADVANCED_ACCESS_APPROVED` in
  `karosCMO/.env.example`, the same flag its own Meta integration already
  gates on), or — for `meta.publishInstagramPost` specifically —
  `META_PUBLISH_ENABLED` is unset.
- `not_connected` / `UNAVAILABLE` (per call, `MetaReadOutcome.status`) — this
  specific client has no Page id on file, removed Karos Labs as a Business
  Manager partner, or the Graph API call itself failed. Never a fabricated
  zero — see `MetaMediaInsights`, where a metric a media type does not
  support comes back `null`, not `0`.

## Metric support by media type (Meta's own rule, not this package's)

| Metric | FEED | REELS | STORY |
| --- | --- | --- | --- |
| `reach` / `views` / `shares` | yes | yes | yes |
| `saved` | yes | yes | no |
| `follows` / `profile_visits` | yes | no | yes |

`metricsForMediaType` in `insights.ts` is the one place this table is
encoded; a metric not requested for a media type is reported `null`.

## Not part of `createAllKarosTools()`

Same reason `karos-connectors` and `media.*` aren't: this reaches a
third-party API on a shared credential, so a caller asking for "all karos
tools" should not silently acquire Graph API egress. A composition root
(`apps/agent-server`) wires `createKarosMetaTools()` in explicitly.
