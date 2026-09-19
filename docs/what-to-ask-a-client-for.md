# What to ask a client for, and what happens when they don't

**SCRUM-338.** Per agent: the visual and branding input it actually reads, where
that value comes from, and exactly what the run does when it is missing.

Every row below was read out of the code rather than out of anyone's intention,
and cites where. That matters more here than usual, because the failure this
document exists to prevent is asking a client for an asset nothing consumes —
and its mirror, shipping a client a plain-looking post because a field nobody
knew was load-bearing was blank.

Three things to know before the table.

**There is one brand record, not one per agent.** The portal's
`BrandingGuidelines` (`karos-portal/src/lib/types.ts`) is projected by
`toProjectedBrand()` into `ProjectedBrand` and served to every agent by
`client.getBrand` (`packages/tools/karos-client/src/get-brand.ts`). So "ask the
client for a logo" is one request that reaches four agents and is ignored by
nine. The table says which.

**Absent is almost never a hold; invalid sometimes is.** The fleet's consistent
posture is that a missing asset degrades the output and a malformed one stops
the run. `visual-qa-pre-checks.ts` puts it plainly: a permanently unreachable
logo must not *"genuinely HOLD THE RUN over a logo"*. The three real holds are
listed under **Holds** below, and none of them is about a logo.

**Five agents read no visual input at all.** That is a row worth having. Do not
collect brand assets for blog, reddit, seo-geo, intel-report or reputation runs;
nothing will look at them.

---

## The table

| agent | reads | when it is missing |
|---|---|---|
| **instagram-agent** | `logoUrl`, `accent` / `colors` / `dominantColors`, `fonts.heading`+`body`, `handle`, plus a hand-authored `instagramBrandTokens` block in client config | always degrades, never holds on a visual field. No logo → the brand-asset criterion is dropped from visual QA entirely rather than scored as a failure. Malformed `instagramBrandTokens` → **hold** |
| **branded-shorts-agent** (= `tiktok-editing-agent`) | `logoUrl`, palette (`accent`/`colors`/`palette`/`dominantColors[].hex`), `fonts` | logo → **the brand's initial letter** in the display face, and says so in the run notes. No colour at all → **hold**. No loadable font → **hold** |
| **tiktok-agent**, **-clipping**, **-content-design** *(one workflow, three variants — identical visual behaviour)* | `logoUrl` (https only), `colors.neutralDark`/`neutralLight`, `accent`, `handle`, `seriesHeader`; and in agent config `sourcePool`, `voiceName` | logo → silently omitted. Colours → silent engine defaults (`#17181C` / `#F4F2EC`). No series header → "the bar stays bare rather than inventing one". **All four footage tiers dry → hold** |
| **newsletter-agent** | `logoUrl`, `dominantColors`/`colors`, `fonts` | logo → **the brand name as a text wordmark** in the heading face. Colours → hard-coded neutrals. All silent. No brand record at all → hold |
| **x-agent**, **linkedin-agent** | `aesthetic`, `lighting`, `palette` (first 6), `accent`, `visualMood` — art direction for generated imagery only | generation runs unsteered. Silent. **Neither reads `logoUrl`**: no logo, watermark or template is composited on an X or LinkedIn image, and `generate-image.ts` constrains generation to "no lettering, no logos" |
| **landing-builder-agent** | the whole brand kit, handed to the blueprint model as JSON; the logo comes from `blueprint.assets`, **not** from `brand.logoUrl` | no `og:image`. Silent |
| **reddit-agent** | **nothing.** `BRAND_VISUAL_KEYS` explicitly strips `colors`, `dominantColors`, `fonts`, `logoUrl`, `accent`, `logo`, `palette` before the planner sees the kit | n/a |
| **blog-agent** | **nothing visual** — the kit is carried for voice | n/a |
| **seo-geo-agent** | **nothing visual** — but the brand record must exist or the run is held | n/a |
| **intel-report-agent** | **nothing visual** | n/a |
| **reputation-agent** | **nothing visual** | n/a |

### Holds, in full

Only these three stop a run, and it is worth knowing that none is a logo:

1. **branded-shorts, no colour** — *"the client's brand kit names no colour at
   all, so a brand profile cannot be derived"* (`derive-brand-setup.ts`). Only
   when a profile is actually needed; otherwise it degrades to engine neutrals.
2. **branded-shorts, no usable font** — nothing loadable from Google Fonts or
   the system faces.
3. **tiktok, every footage tier dry** — user assets, owned footage, web harvest
   and stock all empty. The workflow's own justification is the honest one:
   *"A video post has no typographic fallback — this hold is honest."* A text
   post can fall back to text; a video cannot fall back to nothing.

### What to actually ask for, per client

In priority order, by how much the output changes:

1. **A palette** — three or more hex values, ideally with roles. Reaches
   instagram, branded-shorts, tiktok, newsletter, x and linkedin. Its absence is
   a hold for branded-shorts and silent neutrals everywhere else.
2. **Footage, for any TikTok client** — `sourcePool`, as `gs://` or `https://`
   URIs, or show names the client is allowed to clip. This is the only entry in
   this document whose absence **stops a run**, and it defaults to empty and
   stays *"a deliberate human decision"*.
3. **A logo, as an `https://` PNG or JPEG** — see the two constraints below.
4. **Fonts** — heading and body. A hold for branded-shorts; a fallback stack
   elsewhere.
5. **A handle** — instagram and tiktok stamp it; regex-validated, so a malformed
   one is simply dropped.

Do **not** ask for logos, palettes or fonts on behalf of blog, reddit, seo-geo,
intel-report or reputation work. Nothing reads them.

### Two constraints on a logo that a client will hit

**It must be `https://`.** A `gs://` URL is refused by every agent that renders
one, because `downloadBrandLogo` fetches https only. Portal uploads already
produce https URLs; a path pasted from a bucket does not.

**It must survive a contrast floor.** A logo is placed only where it clears
3:1 against the plate behind it (`BRAND_LOGO_CONTRAST_FLOOR`). Under that on
every candidate plate, `planBrandLogoPlacement` returns `omit` and the post
renders without it, silently. A mid-grey logo on a photographic background is
the case that hits this. A logo with its own contrast — or a version with a
light and a dark variant — is what avoids it, which is the strongest practical
argument for the multi-asset proposal below.

---

## Two things this document found that belong on other tickets

**`tiktokClips.musicUrl` does not exist.** SCRUM-438 is *"source licensed
background music and wire it to `tiktokClips.musicUrl`"*. There is no such
field: not in `agents/tiktok-agent/src/workflow/types.ts`, not in the workflow,
nowhere in `agents/` or `packages/`. The ticket is a build, not a purchase plus
a config change, and buying a licence before the field exists buys something
nothing can play. `voiceName` and `voiceLanguage`, by contrast, are real and
wired.

**The `gs://` rejection is asymmetric, and one side thinks it is not.**
instagram refuses a `gs://` logo *at derivation* and records
`rejectedLogoUrlReason`, so the run can say why the logo is absent. tiktok
applies the same https-only rule and drops the value silently, with nothing
recorded. instagram's own comment says its derivation *"matches
`videoBrand.logoUrl`'s derivation in tiktok-agent"* — the rule matches, the
reporting does not. A client whose logo is a `gs://` URL gets an explanation on
instagram and an unexplained bare post on tiktok. Small fix, worth its own
ticket.

---

## The ticket's own proposal: several logos, one picked per post

The ticket asks for *"small logo image uploads… if multiple logos are provided,
the agent should randomly pick one per post"*. **Nothing supports more than one
logo today**, so this is a proposal rather than a gap. Recording what it would
take, because two of the three pieces already exist:

* `BrandingGuidelines` carries one `logoUrl` and one `logoStoragePath`, and
  `ProjectedBrand`, `ClientBrand`, `BrandRenderTokens` and `VideoBrand` each
  carry a single `logoUrl?: string`. That is the change: a list, and a portal
  surface that uploads into it rather than replacing.
* **The storage layout is already plural.** The portal's logo route writes to
  `clients/<id>/logos/<uuid>-<name>` — a directory with a per-upload uuid. The
  record points at one file and the previous is deleted on replacement, so the
  shape is there and only the pointer is singular.
* **The per-post selection pattern already exists**, twice. instagram's
  `paletteForSlide()` walks the accent ring one step per slide, phase-shifted by
  a run seed; the media library's `selectLibraryCandidates()` chooses among many
  client assets. Either is a better model than `Math.random()`, and the reason
  is not style: a seeded walk is reproducible, so a client asking *"why did this
  post use that mark"* has an answer, and a re-run of the same post does not
  silently change.

One caution on the design. Random-per-post is right for **variants of one mark**
— a light version, a dark version, a stacked version — and wrong for genuinely
different marks, where the client will read the variation as inconsistency. If
the list is built, it is worth it carrying a role per entry (`light`, `dark`,
`stacked`) so the choice can be made by what the plate needs rather than by
chance, and the contrast floor above stops omitting logos that had a usable
variant sitting beside them.

---

## Where this sits next to what already exists

Three tables in the repos do neighbouring jobs, and none covers this one:

* `packages/core/src/diagnostics/capability-catalogue.ts` — per **capability**
  (an env var), with `whenAbsent` on every row. It has no row for brand, logo or
  palette, and correctly so: branding is client data, not a deployment
  capability.
* `packages/core/src/diagnostics/capability-products.ts` — per **product**,
  `requires` versus `enhances`. The closest existing shape to this document, and
  the right table to extend if any of this should become machine-checked.
* `karos-portal/src/lib/agent-engine/engine-field-contract.ts` — per product,
  which **brief** fields the engine really reads, each with a file-and-line
  citation. Same discipline as this document, for run inputs rather than assets.

The current logo behaviour is pinned by
`packages/tools/karos-media/__tests__/brand-logo-contrast.test.ts` and
`agents/instagram-agent/__tests__/brand-logo-outcome.test.ts`.
