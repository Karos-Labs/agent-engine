# `@agent-engine/tool-karos-templates`

The slide-template registry: archetype definitions stored in Firestore,
materialized to a per-run directory for the renderer.

## Why it exists

The five slide archetypes (`stat_callout`, `quote_card`, `comparison_card`,
`list_takeaway`, `headline_focus`) shipped as HTML files inside
`agents/instagram-agent/assets/templates/default/`. That works, and it is
still the floor, but it means a new layout is a code change and a deploy, and
a template a run generates can never be kept.

This package makes the library **data**: rows a person can add, a run can
propose, and a reviewer can promote.

## The layers

```
createTemplateStore({ bundledTemplateDir, firestore })
  └─ composite
       ├─ bundled   (read-only, the on-disk files, source: "legacy")
       └─ firestore (read/write, source: "curated" | "ai_generated")
```

The bundled layer is unconditional and always first. **A remote layer failing
is absorbed, not propagated** — if Firestore is unreachable the run renders
from the files inside the container with less variety, rather than failing.
Same reasoning that keeps the keyless providers unconditional in
`karos-media`: the registry must never be able to take rendering down.

There is no `not_available` mode and no `undefined` return, deliberately.
Unlike an image provider there is no such thing as a deployment that does not
need slide templates. What a missing Firestore costs is variety and the
ability to promote, never the ability to render.

## Which template wins an archetype

`resolveBest` picks one row per `archetypeId`:

1. Highest `qualityScore`.
2. At equal score, a `clientSlug`-scoped row beats a global one — a client
   that bothered to author its own template means it.
3. Full tie broken by `id`, so two runs of the same input can never resolve
   differently. A rendering difference must always be attributable.

Opening scores (`DEFAULT_QUALITY_BY_SOURCE`): `legacy` 70, `curated` 60,
`ai_generated` 40. Legacy sits highest not because porting beats authoring,
but because the ported set is the only one whose rendering has actually been
verified end to end.

## Approach (a): materialization

`publish.renderCarousel` resolves `templateDir` and every image path through
`assertInside`, which refuses absolute paths, URL-shaped strings, and anything
escaping the repo root. That guard is why a bad path there is a *tooling*
failure rather than a silent render of the wrong thing, and it works precisely
because the renderer only ever deals in repo-relative **files**.

So rather than teach the renderer to accept template bodies — which would mean
either weakening that check or growing a second input path with its own weaker
guarantees — `materializeTemplates` writes the winning templates into
`<repoRoot>/.template-cache/<runId>/` and returns that directory:

```ts
const { templateDir, files, typographicArchetypes, chosen } =
  await materializeTemplates({
    store, repoRoot, runId, clientSlug,
    clientTemplateDir: brandTokens.templateDir,   // copied in alongside
    clientTemplateFile: brandTokens.slideTemplate,
  });
```

One code path, one set of guarantees, a few KB of writes per run. The client's
own base template is copied in because the renderer takes **one**
`templateDir` and the `photo` archetype still routes to whatever file that
client configured.

`.template-cache` must be writable. On Cloud Run the filesystem is read-only
apart from mounted volumes, so `cloudbuild.yaml` mounts an in-memory volume
there, exactly as it already does for `.media-cache` and `instagram-output`.

## `htmlTemplate` and `cssStyles` are separate fields

They are concatenated back into one document at materialization, so the split
buys nothing at render time. It buys everything at authoring time: the five
ported archetypes each duplicate an identical ~20-line design-token block,
because the renderer reads one self-contained file per slide and has no
include mechanism. With the CSS as its own field a shared token sheet can be
composed in front of each template's own rules — the only way this library
grows past a handful of files without the tokens drifting.

`composeDocument` injects `cssStyles` immediately before `</head>`, so
registry CSS lands *after* the template's own `<style>` and wins specificity
ties. A row with empty `cssStyles` is returned untouched, so materializing a
bundled template is byte-identical to reading it from disk.

## The flywheel

```ts
// A run generated a layout and a reviewer approved it.
await promoteTemplate({ store, archetypeId: "stat_callout", htmlTemplate,
  layoutType: "typographic", source: "ai_generated", actor, note, now });

// A reviewer weighed in on a template already in the library.
await reviewTemplate({ store, templateId, verdict: "revise", note, actor, now });
```

Two rules make this trustworthy:

- **A template only enters the registry after a person approved it.** The
  rendering path never writes. A run that invents a layout does not get to
  enrol its own work, or one bad generation becomes a permanent fixture that
  later runs keep picking and `qualityScore` measures nothing.
- **An approved AI template still opens at 40, below the bundled floor of
  70.** One person liking one render is evidence, not proof. It is available
  immediately to the client it was scoped to, and competes globally only once
  it has accumulated approvals.

Score deltas are asymmetric (`QUALITY_DELTA`: `approved` +5, `revise` -15).
A design people keep asking to change should fall out of contention quickly;
one they like should have to earn its way past a proven template over several
runs. Scores are clamped to 0..100 so a streak cannot make later comparisons
meaningless.

## Known limits, stated rather than hidden

- **Reads fetch the whole collection and filter in memory.** Correct at this
  scale (tens of rows) and only at this scale: a compound Firestore query over
  `(clientSlug, archetypeId, enabled)` needs a composite index per
  combination, for a collection small enough to fetch whole. Past a few
  hundred templates the query moves server-side and the index comes with it.
- **`recordFeedback` is read-modify-write, not atomic.** Two reviewers
  commenting on one template in the same instant could lose a note. Feedback
  arrives at human pace, one reviewer per run; buying atomicity would mean
  depending on the real SDK's `FieldValue` and giving up the plain-object
  testability the narrowed `FirestoreLike` seam exists for.
- **Binary template assets (fonts, textures) are not modelled.** GCS is the
  right home for those; this store deliberately does not half-model them.
- **A malformed Firestore row is skipped, not fatal.** One hand-edit in the
  console must not take every other template down with it.
