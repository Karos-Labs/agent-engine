# RFC-26 — Instagram exemplar harvest: learn from what actually performed

Status: Phase 1 in progress (2026-09-24). Owner request, same day.

## The ask

> Add a tool that harvests hundreds of posts, from the client and from its competitors (all Instagram), sees what got traffic, judges what was beautiful and high quality, what earned many likes, views and comments, and can then produce the good posts accordingly. It enters the setup process, so we have many examples that count as the best, and we adapt templates, placements and that kind of information from these harvests, and it serves the client in the next runs.

Today the agent learns "what good looks like" from four hand-picked reference accounts (`docs/instagram-restraint-reference.md`, not in code), from the client's brief, and from `media.ingestVisualPatterns`. That last one is capped at 4 accounts × 25 posts, is consent-gated, and keeps prose only, no images. Nothing reads a competitor's Instagram. Nothing judges a real post's craft.

## What exists (measured 2026-09-24)

| Piece | State |
|---|---|
| ScrappyCoco `instagram.account_posts` | 12 posts/call, **$0.0019/call**. Paging: `input.cursor` = response `cursor` while `more_available`. Probed live on @semrush (page 2 = the next 12, 2026-09-07 → 08-21). Returns `like_count`, `comment_count`, views for reels, `carousel_media[]` with every frame's `image_versions2`, caption, `taken_at`, `product_type` (`carousel_container`/`clips`/`feed`). |
| `research.socialHistory` | 12 posts, **drops image URLs**, 600-char excerpt. |
| `media.ingestVisualPatterns` | 4 × 25, consent-gated (`clients/<slug>/client/consent.json`, no writer exists), prose profile. |
| Competitors | `client/competitors.json` `{name, website}`, intel roster `intel/competitors.json`. **No Instagram handle anywhere.** |
| Reference accounts | `brief.referenceAccounts[]` `{platform, handle, why}`, max 7. |
| Setup slots that would consume exemplars | `00c2-gather-format-evidence` → `StudioEvidenceBundle.referenceFormats` (caption regexes today, "no reference-post images were inspected"); `00d1`/`00d2` visual direction `patterns` + `ownImageNotes` (supported, never produced); copy `hookPattern`. |
| Owner rule | ScrappyCoco only; no new vendor. |

The Meta Graph API cannot read competitors (it only reads accounts that added Karos as a partner), so it is not part of the harvest. It remains the source for the client's own reach and saves (RFC-22 §3.1).

## Design

### Phase 1 — harvest and rank (this PR)

1. **Accounts.** `resolveHarvestAccounts` gathers:
   - the client's own handle;
   - `brief.referenceAccounts` with `platform: instagram`;
   - competitors' handles, resolved from each competitor's website (the `instagram.com/<handle>` link on its home page, fetched for free, never guessed);
   - handles the operator lists explicitly (`input.harvestAccounts`).

   Every handle is deduplicated and labelled with its role: `client`, `competitor` or `reference`.
2. **Harvest.** `scraper.socialHistoryPage` pages each account up to `maxPostsPerAccount` (default 120) or `sinceDays` (default 365). About 10 calls per account, so roughly $0.02 per account and $0.20 for ten.
3. **Normalise.** `instagramPostFromRecord` reads the vendor JSON into one shape: format, frame count, one full-size URL per frame in order, likes, comments, views, caption, first line (the hook), and posted time.
4. **Rank within the account, then across accounts.** Raw likes favour big accounts, so every post is scored as a **percentile inside its own account and format**. Carousels and singles use `likes + 3·comments`; reels use views, with likes as a tie-break. A 20-like post on a 2k account can beat a 900-like post on a 1M account. The library keeps the top quartile per account, and the overall list interleaves roles so the client's own winners are never crowded out.
5. **Store.** `clients/<slug>/exemplars/harvest-<yyyy-mm-dd>.json`: every post with its scores, plus a summary per account and per format (share of carousels, median frames, engagement by format).

### Phase 2 — judge and copy

- Copy each top post's frames to the media bucket **before the CDN links expire** (Instagram URLs are signed). They are marked `licence: reference-only`, and the image cascade never sees them.
- A vision judge (gemini flash, about $0.001 per frame) reads the top ~40 posts. It returns a craft score (1–5), which is separate from engagement: a post can be popular and ugly.
- It also returns a **design DNA** record: cover type, how many element groups each slide has, text density, picture placement (full-bleed / inset / split / none), palette relation to brand, type style, the device used (figure / quote / list / comparison), slide count, and hook pattern.
- An exemplar is kept when it ranks high on **both** engagement and craft. Popular but low-craft posts go into the summary as "what this audience rewards", never as a look to copy.

### Phase 3 — feed setup and the runs

- `00c2` (Template Studio) receives the exemplar DNA **and images**, so the design brief is written from real posts that performed in this niche, not from caption regexes.
- `00d2` (visual direction) receives the client's own top posts as `ownImageNotes`, and competitors' DNA as `patterns`.
- The run's rotation weights read the library, which becomes a per-client prior:
  - figure placement (inset / full-bleed);
  - carousel length;
  - the share of photographic slides;
  - device mix.

  Owner rulings still bind: one visual system per carousel, additive looks, and no copying a competitor's exact post.
- Hooks: the top first lines by format feed the copy prompt as patterns, never as text to reuse.
- Refresh every 30 days, in setup (`00h-harvest-exemplars`, TTL like the brief's).
- The portal shows the library as a "what performs in your niche" page.

### Guard rails

- **Never republished.** Harvested images are reference material only. The picture cascade cannot select them, the copy never quotes a competitor's caption, and a competitor's name stays refused in copy (`02a2`).
- **Consent.** Reading the client's own history already has a consent gate (`consent.json`, which nothing writes today). Reading competitors' public posts through the licensed vendor for internal analysis is a different question. **The owner decides the policy for both** before Phase 3 runs automatically in setup. Phase 1 is a tool invoked explicitly.
- **Cost.** Metered on the setup budget (`instagramSetupBudget`), about $0.25 per full harvest plus about $0.05 of judging.

## Phase 1 acceptance

- A unit-tested normaliser over a real recorded vendor page: frames, counts, format, hook.
- Paging stops at `maxPostsPerAccount`, at `sinceDays`, or at `more_available: false`, whichever comes first.
- The ranking is percentile within account and format, proven by a fixture where a small account's post outranks a big account's.
- Handle resolution from a website finds `instagram.com/<handle>` links and ignores `/p/`, `/reel/` and `/explore/` paths.
- A live harvest of 3 accounts × 120 posts is reported to the owner.
