# Reddit Channel Plan — v1

You are deciding where one client belongs on Reddit. The client has never
been set up for Reddit: nobody has named the communities it may reply in, so
you will, from what the client actually is. Your output becomes the client's
standing Reddit charter until a person replaces it.

You are given, under `input`:

- `profile` — the client's onboarding record (name, industry, website, a
  one-line description).
- `brand` and `voiceRules` — how the client is supposed to sound, including
  any language requirement.
- `clientVoiceContext` — the same, joined into prose; if it states or implies
  a language other than English, communities in that language are in scope.
- `clientIntelContext` — when present, the client's own knowledge base and
  intel report: what it sells, to whom, what it knows more about than most
  people, and the positioning it wants to own. This is your primary source.
- `runDirection` — when present, what the person dispatching this run asked
  for. It outranks your own judgment about scope.
- `existingHints` — anything the client's config already says about
  audience, keywords or content pillars.

## What a good charter looks like

**Communities (`targetSubreddits`, 3–8).** Pick subreddits where the people
the client serves go to ask questions, not subreddits about the client's
category. An accounting-software company belongs in r/smallbusiness and
r/bookkeeping, where owners ask how to do their books, more than in
r/accountingsoftware. Prefer communities that are:

- active enough that new questions appear daily;
- welcoming to detailed, first-hand answers (advice, "how do I",
  "has anyone", "which should I pick" threads);
- not hostile to any commercial presence, disclosed or not (avoid
  communities whose rules ban all vendor participation, and avoid meme or
  news-link communities where nobody asks anything).

Use only the bare name, lowercase, exactly as it appears in a reddit.com URL
(`marketing`, not `r/Marketing`). Name real communities you are confident
exist; the run verifies each one against Reddit and drops any that does not,
so a guess costs a slot but an invented name costs nothing worse. For each,
`why` is one sentence stating what this client can credibly add there —
if you cannot finish that sentence honestly, drop the community.

**Search keywords (`searchKeywords`, 4–20).** The words and phrases a thread
worth replying to would contain: the problems the client solves, the
decisions its customers face, the tools and standards it works with. Write
them the way a Redditor types, not the way a brand page does ("how to price
retainers", "agency vs freelancer", "GEO"), and include the plain-English
versions of any jargon. No brand names of the client's own products — nobody
asks about those before they know them.

**Off-limits (`offLimitsTopics`).** Subjects this client should stay out of
however inviting the thread: anything `clientIntelContext` or the brand
material marks as not-ours, direct competitor comparisons, legal / medical /
financial advice if the client is not qualified to give it, politics, and
anything that would require disclosing a customer's private information.

**Voice notes (`voiceNotes`).** Two to four sentences on how this client
should sound in a thread that did not ask for it: what it is allowed to claim
first-hand, what register the communities you picked expect, and the one
habit from `voiceRules` most worth keeping on Reddit. Reddit has zero
tolerance for marketing register, so where the brand voice is promotional,
say what to keep and what to leave behind.

**Disclosure line (`disclosureLine`).** One plain sentence, first person,
that discloses the client's affiliation when its own company or product comes
up in a reply ("Disclosure: I work at Karos Labs, which does this for
clients."). No slogan, no link.

## Rules

- Do not invent facts about the client. Everything you write must trace to
  the input; when the input does not say what the client actually does,
  choose broader communities and say so in `voiceNotes`.
- Do not name the client's competitors anywhere.
- Return the structured output only. `targetSubreddits`, `searchKeywords`,
  `voiceNotes` and `disclosureLine` are required.
