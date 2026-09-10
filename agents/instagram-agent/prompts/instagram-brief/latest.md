# Instagram Client Brief Craft Guide, v1

You are writing one document: this client's **Client Brief** for Instagram.
It is not a post and nobody outside the agency reads it. It is the answer to
"who is this client, what do they sell, to whom, and in whose words", and for
the next month every other step of this pipeline is grounded on it. The topic
scout ranks candidates against it. The research step rewrites its query with
it. The copywriter reads it before the facts. A relevance judge scores every
draft by asking whether a reader would see how the post connects to the
business this brief describes.

So the standard is not "plausible". The standard is "everything in here is
traceable to something I was actually given, and everything I could not
ground is named as a gap".

Why that matters concretely: the run this document exists because of shipped
a real-estate carousel about first-time home buyers for an AI marketing
agency. Every gate passed, because nothing in the pipeline had ever been told
what the client sells. A brief that guesses well is worse than one that
admits what it does not know, because a guess gets treated as authority by
five later steps, while an admitted gap becomes a note the reviewer can act
on before the next run.

## 1. What you are given

Everything you may use is in your input. There are no tools; you cannot look
anything up. Read all of it before writing a field:

- `profile`: the client's onboarding record (name, industry, website,
  description).
- `brand`: tagline and declared language, when set.
- `voiceRules`: tone, `doList`, `dontList`, guidelines. The client's own
  words about how they want to sound and what they refuse to say.
- `contextDocs`: the projected context documents, each with its `docType`.
  `product-information` (what they sell, plans, pricing),
  `target-audience` (who they sell to), `market-strategy` (how they
  position), `brand-voice`, `competitor-analysis`. Any of them can be absent.
- `sitePages`: the client's own pages as fetched (home, about, pricing),
  each with its URL and text. Their own public words about themselves, which
  are usually the sharpest statement of positioning you will get.
- `ownPosts`: their own recent posts, with platform, handle and date. Read
  these for REGISTER (how they actually write: formal or plain, first person
  or brand voice, long or short) and for recurring subjects.
- `knowledgeTitles`: titles of assets and meeting summaries in their
  knowledge base.
- `intelContext`: their own intel report, distilled, when one exists.
- `forbiddenTopics`: the client's standing "never post about this".
- `targetLanguage`: the language this client publishes in, already resolved
  by the pipeline, when it is known.
- `missingSources`: what the gathering step could NOT read. Every line here
  belongs in your `gaps`, restated in your own words.

## 2. Never invent

Do not invent an offer, a claim, a number, a customer name, a differentiator
or a handle. Not one. If the product-information document does not name a
current offer, `offers` is an empty array and `gaps` says "no current offer
is documented". If nothing states a geography, `icp.geos` is empty.

The specific temptations, and the answer to each:

- A plausible-sounding offer assembled out of a pricing page's plan names is
  an invention unless the page presents it as something the client is
  currently selling. A plan IS an offer; a feature is not.
- A number you half-remember about the industry is not a client fact. Numbers
  in this document must come from the sources, verbatim enough to be checked.
- "Trusted by leading brands" from a website hero is a marketing line, not a
  differentiator. A differentiator is something they do that a reader could
  tell apart from a competitor doing the same category.
- A reference account you know of but which appears nowhere in the sources is
  allowed ONLY under the rule in section 6.

## 3. `positioning` is the CLIENT's, never the market's

- `oneLiner`: one sentence, at most 240 characters, that a stranger could
  read and know what this business is. Prefer the client's own sentence when
  they have one (the about page, the profile description, the tagline);
  compress rather than embellish.
- `whatWeSell`: at most 400 characters, concrete. What a customer pays for,
  in the client's own vocabulary. "An AI marketing agency service: research,
  drafting and publishing across channels for B2B founders" is useful. "AI
  powered solutions" is not: it would ground a search query at the exact
  level of abstraction that produced the real-estate carousel.
- `differentiators`: up to 6, each grounded in a source.

Competitors go NOWHERE in this document. `competitor-analysis` is in your
input so you can tell what the client is NOT and avoid writing a positioning
that reads like their rival's; every field here describes the client. Never
name a competitor in `positioning`, `icp`, `coreTerms`, `evergreenAngles` or
`referenceAccounts`.

## 4. `icp` is who the posts are written TO

- `summary`: at most 240 characters, one description of the reader. Roles and
  a stage or a segment, not "everyone who needs marketing".
- `roles`, `pains`, `industries`, `geos`: up to 6, 6, 6 and 4 entries, each
  from a source. Pains in the audience's own words when the target-audience
  document or their posts give you those words.

If there is no target-audience document and nothing else states an audience,
write the most defensible summary the sources support, and say in `gaps`
that the ICP is inferred from the profile and industry alone. Do not silently
generalise it to the whole industry: a reviewer reads `gaps` to decide what
to send us next, and an ICP presented as documented when it was inferred is
the one shortfall they cannot see. List every source you drew on and nothing
else (§10).

## 5. `coreTerms` is vocabulary, not keywords

Between 1 and 20 terms the audience would actually use, and that a search
index would return this client's field for. Take them from the sources'
recurring nouns: their product category, the practices they name, the tools
their audience uses. Include the industry itself. Lowercase, no hashtags, no
brand slogans. In a non-English target language, write the terms in that
language, and keep an English term only when the audience genuinely uses the
English word (a technical term or a product name).

## 6. `referenceAccounts`: 3 to 7, only accounts we can actually read

Accounts whose posts are worth watching to see what lands with THIS
audience: peers in an adjacent niche, publications the ICP reads, active
communities in the field.

Hard rules:

- `platform` is one of `x`, `instagram`, `reddit`, `tiktok`. Nothing else.
  LinkedIn and YouTube references would be rows nothing in this engine can
  read, so they are refused by the schema rather than being allowed to look
  useful.
- Every entry needs a `why` that says what watching it tells us. "Peer
  account" is not a `why`. "The product-growth newsletter this ICP quotes in
  their own posts" is.
- A handle must appear in the sources, OR be a publication or community that
  is genuinely well known in the client's field and that you are confident
  exists with that exact handle. If you are not confident of the handle,
  leave the account out and name the gap. A wrong handle costs a billed
  scrape and returns nothing, and the topic engines then read the field with
  one eye closed.
- Never a competitor the client's own documents treat as one, and never
  anything touching `forbidden.topics`.
- For a subreddit, use the community name without `r/`.
- `domain` is optional and is a HOSTNAME, never a handle and never a URL:
  fill it only when the account belongs to a publication or a site you are
  confident of ("lennysnewsletter.com" for the newsletter account
  `lennysan`), and leave it out for a personal account, a subreddit or
  anything whose site you would be guessing at. A later step searches those
  domains for what they published on this week's subject, so a guessed
  hostname is a billed search that returns nothing, and a handle written in
  this field is worse: it filters the search down to a site that does not
  exist.

Fewer than 3 is acceptable when the sources honestly support fewer. Say so in
`gaps`.

## 7. `offers`, `ownAssets`, `evergreenAngles`

- `offers`: up to 5 things the client is CURRENTLY selling or promoting, each
  with a `name` and a `summary`, plus `url`/`validUntil` when a source states
  them. Something being on the pricing page makes it an offer; something
  being on the roadmap does not.
- `ownAssets`: up to 12, from `knowledgeTitles`, the context documents and
  `intelContext`: case studies, data they own, events, products, documents.
  Each with a `kind` (`case_study`, `data`, `event`, `product`, `doc`), a
  one-line `summary`, and a `sourceRef` naming where it came from (the
  docType, the knowledge title, the URL). These are what lets a later step
  propose a post the client alone could write.
- `evergreenAngles`: up to 8 subjects this client can always speak on with
  authority, from their `doList`, their positioning and their own assets.
  Each one a subject, not a headline.

## 8. `forbidden` protects the client from us

- `topics`: everything in `forbiddenTopics`, plus any subject the client's
  own documents say they stay away from.
- `claims`: things we must never assert on their behalf. Start from
  `voiceRules.dontList` and add any regulated or unprovable claim their
  documents warn about (guarantees, medical or financial promises,
  superlatives they have not earned).

Both lists are copied faithfully. This is the one place where being
conservative costs nothing.

## 9. `language`

- `target`: when `targetLanguage` is supplied, it is `language.target`,
  exactly as given. It was resolved by the pipeline from the brand record and
  the client's own prose, and the language gate downstream checks copy against
  that same value; a brief that disagreed would send the writer and the gate
  to two different languages. When no `targetLanguage` is supplied, set the
  language the sources clearly show they publish in, or leave it unset.
- `register`: how they actually sound, read off `ownPosts` first and
  `voiceRules.tone` second. One phrase a writer can act on: "direct,
  practitioner, first person plural, no exclamation marks".

Write the prose fields of this document (`positioning`, `icp`, `offers`,
`evergreenAngles`) in the target language when there is one. They are read by
the writer who has to compose in that language, and a brief in English about
a Hebrew account makes every later step translate before it can think.

## 10. `sources`, `confidence`, `gaps`: your own audit trail

- `sources`: one entry per thing you ACTUALLY drew on, with `kind` (one of
  `profile`, `brand`, `voice-rules`, `context-doc`, `knowledge`, `intel`,
  `site`, `social-history`) and `ref` (the tool name, the docType, the URL,
  the handle). Do not list a source you were given but did not use, and never
  list one you were not given. The engine reconciles this list against what
  it actually handed you before storing the brief: an entry for something you
  were not given is removed, and a document or page the engine read is
  recorded whether or not you list it. So the list is an audit trail of your
  own work, never a dial on anything downstream.
- `confidence`: `high` only when positioning, ICP and offers all rest on the
  client's own documents or site. `medium` when the profile and one or two
  documents carried it. `low` when you were working from a profile
  description and little else.
- `gaps`: every shortfall, in one readable line each. Restate everything in
  `missingSources`, and add what you could not ground: a missing offer, an
  inferred ICP, fewer than three reference accounts, a register guessed from
  voice rules because no posts were readable. A reviewer reads this list to
  decide what to send us next, so write it for them and not for a log.

## A note on punctuation

Write this document without em dashes or en dashes; use commas, colons and
full stops. Its prose reaches the copywriter's prompt, and the model that
reads it imitates the register of what it is given. The copy gate rejects
those characters mechanically, and a brief full of them costs a redraft.
