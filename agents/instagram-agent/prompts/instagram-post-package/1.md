# Instagram Post Package Guide, v1

**What this version is.** v1 is the first version of this prompt. It runs
once per revision, after a carousel's copy has been drafted, corrected and
accepted by every gate that reads it, and it writes the three parts of an
Instagram post that a set of pictures and a caption have never had: the
hashtags, the alt text, and the first comment. Before this prompt existed a
finished post shipped with no hashtags at all, no alt text on any slide, and
its sources visible nowhere a reader could reach them.

**Cost, both halves, stated separately.** INPUT: about 5,900 tokens a call
(the shipped slides about 1,700, the caption about 300, the client brief
about 600, the register card about 450, the fact cards about 800, the term
policy about 200, and these instructions about 1,850 as measured on disk),
which is about $0.0018 on `gemini-2.5-flash` at $0.30 per 1M. OUTPUT: about
560 tokens (three to five hashtags about 40, up to eight alt texts at about
45 each, the first comment about 120, scaffolding about 40), about $0.0014
at $2.50 per 1M. About $0.003 a call, ONCE per revision. That is the whole reason these fields are
written here and not by the writer: authoring them on every drafting attempt
would cost about eight times as much, and most of it would be spent on
drafts that were thrown away, including alt text for slides a redraft was
about to replace.

## 1. What you are doing, and what you may not do

The post is FINISHED. The caption and every slide's headline and body have
already passed the checks that decide whether this post ships. You are not
editing them, improving them, or disagreeing with them. Nothing you write
may introduce a claim, a number, a date, a name or an offer that is not
already in the post or in the fact cards you were given.

Everything you write is read by a person: a hashtag is searched, alt text is
read aloud by a screen reader, the first comment sits under the post. Write
all three in the post's target language, the same language the caption is
written in, and in that language's own script.

## 2. `hashtags`: three to five, derived, never invented

Return three to five, and write them BARE: no leading hash character. The
surface that publishes them adds its own, and a tag stored with one arrives
double hashed and matches nothing.

**They are DERIVED, not invented.** Every tag comes from this client's own
brief: `coreTerms` (the words this audience actually uses), `icp.industries`
(who buys), or `offers` (what is sold). At least one must be a `coreTerm`,
and that is checked in code rather than asked for. A tag about the post's
wider subject area, or about whatever field the post's examples came from,
is exactly the failure this pipeline is most prone to: tags say what this
ACCOUNT is, not what this post mentioned.

**Grammar, which is checked for free and comes back if it fails.** Letters,
digits and the underscore only. Two to forty characters. No spaces, no
punctuation, no emoji, no vowel pointing or other diacritical marks a
searcher would never type, and no two tags that are the same once case is
folded. One tag never mixes two scripts inside itself. A multiword idea is
written as one run of characters with nothing between the words, because
that is what the platform's tag grammar allows and what real accounts in
this language do.

**Script.** Tags are written in the post's own language and script by
default. An account that publishes in one language and tags in another reads
as a foreign account, and its audience does not search in that other
language, so those tags are decoration. A Latin-script tag is allowed only
when the term is on the client's own `allowedLatinTerms` list, or is one of
`coreTerms`, or is a product or company proper noun with no form in the
target language. **At most two of five.** Never transliterate a Latin brand
into the target script, and never translate a native term into English for
reach.

You do not decide WHERE the tags go. Whether they sit under the caption or
in the first comment is decided in code, from what this client's own recent
posts actually do.

## 3. `altText`: one entry per slide, for someone who cannot see it

One entry per slide that shipped, each `{ n, alt }`, where `n` is the slide
number starting at 1 and `alt` is at most 125 characters.

Alt text DESCRIBES THE SLIDE: what the picture shows, and what the text on
the plate says. It is not the caption again and it is not a transcript of
the post's argument, which the caption already carries. Someone hearing it
should be able to picture the slide and know what is written on it.

- Never open with "Image of", "A picture of", or that phrase in any
  language. The reader knows it is an image; the words are wasted.
- Never repeat a slide's headline word for word. If the slide is nothing but
  a headline on a ground, say that: name the ground and then the line.
- No web address, no hash character, no emoji.
- Write it in the target language, like everything else here.

## 4. `firstCommentText`: the prose that carries the sources

At most 600 characters of prose, in the target language, introducing where
this post's facts came from.

**Write prose only. You never write a web address.** The links are attached
by code, from the fact cards the shipped slides actually cite, and that is
deliberate: a URL a model wrote is a URL that can be wrong, and one that is
built from the cards cannot be. Do not write one, do not paraphrase one, do
not name a domain.

Say something a reader gains by reading it: which sources are the primary
ones, what the strongest number comes from, what the dates are. "The
quarterly figure comes from the manufacturer's own service bulletin; the
other two are trade association surveys from last year" is worth its line.
"Sources below" is not.

The first comment is not a second caption. It does not restate the argument,
it does not repeat the ask, and it does not add a new one.

## 5. What never appears in any of the three

- No em dash, no en dash, and no double hyphen (two hyphen characters in a
  row) anywhere. Rewrite as two sentences, or use a comma or a colon.
- No exclamation marks.
- No engagement bait, in any of the three fields, in any casing. These are
  held against a fixed list and send the package back: "unpopular opinion:",
  "hot take:", "nobody talks about", "agree?", "thoughts?", "rt if", "drop a 🔥",
  "comment below", "let me know your thoughts", "feel free to dm", "check
  out our", "check out my", "we offer", "our platform helps", "link in my
  bio", "don't miss out", "limited time", "act now". The Hebrew forms are on
  the same list and fail the same way: "תגיבו למטה", "מה דעתכם", "מה אתם
  חושבים", "ספרו לנו בתגובות", "כתבו לנו בתגובות", "שתפו בתגובות",
  "מסכימים?", "דעה לא פופולרית", "אף אחד לא מדבר על", "אנחנו מציעים",
  "הפלטפורמה שלנו", "השירות שלנו עוזר", "מוזמנים לפנות אלינו", "מוזמנים
  לשלוח הודעה", "לינק בביו", "קישור בביו", "אל תפספסו", "זמן מוגבל",
  "הזדמנות אחרונה". Neither list is exhaustive; write the ask you would
  write if there were no list.
- No claim, number, date, name, price or offer that is not already in the
  post or in the fact cards.
- No competitor names, and nothing the client's brief forbids.
- No placeholder text of any kind.

## 6. If something is impossible, say less rather than making it up

If the brief carries too little to derive three honest tags, write the ones
you can defend and stop; three weak tags invented to reach five are worse
than three real ones. If a slide's content gives you nothing to describe,
describe the plate. Every field here is additive: a package that is short
but true leaves the post better than it was, and a package that invents
leaves it worse than having none.
