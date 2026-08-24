# @agent-engine/tool-karos-research

Egress-bound, cached, freshness-enforced external research pulls (RFC-01 §9.2).

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `APIFY_TOKEN` | for `research.pull` | Backs external search. Without it `research.pull` reports `not_available`. |
| `APIFY_RESEARCH_ACTOR` | no | Override the actor, default `apify~rag-web-browser`. |

## `research.pull`

Takes `{job, query, window, maxResults}`, returns a cached run when one exists
inside `window`, otherwise searches, persists the payload verbatim, and returns
it. The payload shape (`ResearchPayload`) is:

```jsonc
{
  "provider": "apify/apify/rag-web-browser",
  "query": "how AI marketing teams evaluate new tooling",
  "fetchedAt": "2026-08-23T21:04:11.000Z",
  "documents": [
    { "title": "...", "url": "https://...", "description": "...", "content": "markdown, truncated", "retrievedAt": "..." }
  ]
}
```

Every field exists to serve one downstream requirement: the extraction agent
must attach a **source and a date** to every claim it emits
(`agents/instagram-agent/prompts/instagram-research/1.md` §2). `url` is the
source, `retrievedAt`/`fetchedAt` the date, `content` the substance a claim is
drawn from.

### Why the RAG Web Browser and not a SERP scraper

`apify/google-search-scraper` returns titles, URLs and snippets. A snippet
cannot reliably support either a sourced claim or a date, so the extraction
agent would either emit weak claims or none. `apify/rag-web-browser` searches
*and* opens the top results, returning each page as markdown, which is what
fact extraction actually needs.

Page content is truncated per document (`DEFAULT_CONTENT_CHARS`, 4000). This
payload is injected whole into the extraction agent's prompt, so its size is a
token bill on every research-backed run, and a full article is mostly
navigation chrome.

### The stand-in that used to live here, and why `not_available` replaced it

This tool shipped with no egress at all. Its "fetch" returned:

```json
{ "note": "Phase 1 stand-in — no real external fetch wired up yet", "query": "..." }
```

so the caching and freshness contract was real while the search was not. That
was a defensible staging decision which then became invisible, because nothing
downstream could tell a placeholder from a topic with nothing to say about it.

prep run `pubsub-21066191524607951` is the receipt. The extraction agent
reported the only fact available to it, verbatim:

> "The research payload for this run is a Phase 1 stand-in with no real
> external data fetched"

and the copy agent, correctly forbidden from inventing facts, wrote a
client-facing carousel about it: *"This carousel couldn't be written yet"*,
*"Your AI pilot didn't fail, the data did"*. Nothing errored. Every content
agent in the engine had been drafting from nothing, and no signal said so.

So an unconfigured deployment now reports `not_available` naming the missing
credential. **This is a deliberate behaviour change**: a run that cannot
research stops instead of drafting from a placeholder. A held run costs a
retry; a published carousel about our own plumbing costs a client's trust.

### Failure semantics

- **`not_available`** — no backend configured. Nothing is written to the run
  store, so a later configured run is not served a stale placeholder from cache.
- **`tooling_error`** — the backend broke (401 invalid token, 402 out of
  credit, timeout). Never reported as an empty-but-successful payload, because
  that is exactly what made a broken pipeline read as a quiet topic.
- **`success` with `documents: []` and a `note`** — the backend answered
  honestly and found nothing. Distinguishable from both cases above.

## `research.captureVisibility`

Still has no real capture adapter (first-party Perplexity Sonar / Claude
web_search / Gemini grounding, or a paid tracker for ChatGPT + Copilot). It
reports `captureTier: "UNAVAILABLE"` per cell rather than a fabricated answer,
so `seoGeo.score`'s `grade_data_only_rule` correctly excludes it from any grade
and from `N_e`. Unlike `research.pull` above, this one is honest by
construction, so it has not been changed.
