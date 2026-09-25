# Instagram Copy Craft Guide — release history

Read by people, not by the model.

These notes used to sit at the top of the prompt itself, so every drafting
attempt paid to read five stacked "what changed at vNN" blocks — about
12,300 characters of them — describing edits to sections the writer was
about to read anyway. Each block names the section that carries its rule
("see section 2", "section 22 adds"), and every rule they name was verified
to be present in the guide's own body before they were moved here.

A changelog is meta-commentary about the document's history. A drafting
prompt is instructions for one task. Mixing them costs tokens on every
attempt and, more importantly, asks a model already holding thirty rulesets
to hold five obsolete descriptions of them as well.

---

**What changed at v34.** Owner rulings of 2026-09-25 on research round #253: the cover is a photograph of the story's subject by default (a poster); a figure device opens the post only when nothing in it can be pictured (decision 5). The closer never says "link in bio" and never carries a "follow us" line or card (decision 16).

**Cost.** INPUT: about +900 prompt characters. OUTPUT: unchanged.

---

**What changed at v33.** RFC-26 Phase 4c: new section 32 reads the optional
input `nicheHooks`, the hook shapes and shared techniques of the posts that
broke out of their own account's baseline in the client's niche (the setup's
exemplar library). Shapes only, never wording or account names.

**Cost.** INPUT: about +700 prompt characters and up to ~300 of input when
the library exists. OUTPUT: unchanged.

---

**What changed at v32.** Owner feedback round 2026-09-24 (item C, WS-10):
complete human sentences, and no negation habit. The guide itself taught the
habit: section 25's model "correction" was "X is not the reason Y happens. Z
is." and section 26 required a body turning on "not this. that." Both now
state the claim positively, with rewritten English and Hebrew examples. New
section 31 lists the six shapes `07b2-readable-copy` checks for free, each
with a shipped example and its rewrite.

**Cost.** INPUT: about +1,600 prompt characters, about +400 tokens, about
+$0.0012 an attempt. OUTPUT: unchanged.

---

**What changed at v31.** Everything v30 says still stands. Section 12 gains
one paragraph for the new optional input `newsFlash`: a news cover always
briefs a real photograph of the story's subject.

On 2026-09-23 a Geektime news flash (prep `pubsub-21774958982236888`) was a
numbers story; the writer chose a `stat_callout` with `source: "none"`, the
workflow forced the news-frame cover as news mode does, and the frame shipped
with no photograph in it. The writer had not been told the slide would be a
news cover. Now it is, and what that cover needs.

**Cost.** INPUT: about +700 prompt characters, about +175 tokens, about
+$0.0005 an attempt. OUTPUT: unchanged, $0.000.

**What changed at v30.** Everything v29 says still stands. Section 22 gains
"Named before anonymous, real before drawn", and four examples change.

The owner on the 2026-09-23 karoslabs carousel (prep
`pubsub-21703550620756189`): every picture looked AI-generated and generic,
and the real ones were missing. Two of its three pictures were a woman lit by
a laptop in a dark room, one sourced and one generated. The guide had been
teaching exactly that scene: section 6's ChatGPT example offered "a laptop in
a dark room with a cursor blinking", and section 22's examples were
`["a laptop", "a dark room"]`, `["laptop", "wooden desk", "morning light"]`
and "someone at a desk with two tabs open". Those four examples are replaced
by scenes that are not the feed's cliché, and the new paragraph asks for two
picture slides OF a named entity when `namedEntities` has any (the route that
returns real, licensed photographs: the mark, press pictures, the founder),
names the cliché scenes to avoid, and makes `generate` the last resort.

**Cost.** INPUT: about +1,650 prompt characters, about +410 tokens, about
+$0.0012 an attempt. OUTPUT: unchanged, $0.000.

**What changed at v29.** Everything v28 says still stands. Three additions,
from stage 1 of the owner's reference-looks plan (2026-09-23).

Section 19 grows from six device shapes to eight: `position_map` (the Karos
Labs feed's positioning map, always illustrative) and `spec_table` (Deel's
"What was on the table": named terms and their values, a figure in a value
following the figure rules).

Section 7 and section 22 read a new optional input, `pictureDensity`. A client
set to `photo-first` may carry a photograph on every slide but one; the floor
of three is unchanged and every other client reads exactly the range it did.

**Cost.** INPUT: about +2,100 prompt characters, about +530 tokens, about
+$0.0016 an attempt. OUTPUT: unchanged unless the writer chooses a new device.

**What changed at v28.** Everything v27 says still stands, unchanged. The
release history moved out of the prompt and into this file.

v27 opened with five stacked `# Instagram Copy Craft Guide, vNN` blocks —
12,483 characters, 11% of the file — describing edits to sections the writer
reaches two lines later. Every drafting attempt read all five, three attempts
to a run, on the highest-volume agent in the fleet. Every rule those blocks
named was verified present in the guide's body before they were moved, and the
body itself is byte-identical to v27's.

**Cost.** INPUT: about -12,480 prompt characters, about -3,100 tokens, about
-$0.0094 an attempt. OUTPUT: unchanged, $0.000 — nothing about what the model
writes has changed.

# Instagram Copy Craft Guide, v27

**What changed at v27.** Everything v26 says still stands except one
permission, which is withdrawn.

Arrow bullets are no longer allowed in the caption. v23 section 2 said *"arrow
bullets among prose are not [refused]"* and section 2 called an arrow list of
two or three items good writing; the writer read both as recommendations and
used them in every post. The owner, 2026-09-20: *"it is not about how many
arrows appear in a single post, it is about the fact that literally every post
includes arrows. That pattern screams AI/bot... Ban or severely suppress them
so they aren't a default fixture."*

The engine now strips the marker from any line that opens on one
(`MAX_ARROW_BULLETS_PER_CAPTION = 0`), so a caption written with them ships
without them and the words survive. This section exists so you do not write
them in the first place and spend the line's shape on something that lands.

Cost: about +900 characters, about +230 tokens, under +$0.001 an attempt.
INPUT only; OUTPUT unchanged.

# Instagram Copy Craft Guide, v26

**What changed at v26.** Everything v25 says still stands. Section 7's
`list_takeaway` gains the plate's own budget, and section 16 gains
`deviceSteer`.

A slide can be legal part by part and still be a wall. The shipped plate that
prompted this had a headline and four rows each with a two-line note: every
row was under the per-row limit, the statement was under its own, the pixel
gate passed it, and it was about a hundred words. The owner: *"there are
slides with too much copy for one slide"*, and then *"a lot of copy on one
page is not good either, regardless of small type"*.

The second change answers a different note on the same carousels. v23 section
2 permits arrow bullets, the writer took the permission for a recommendation,
and the owner read four posts in a row that all used them: *"once in a while it
is fine, but repetitive things like this look AI"*. No sentence in a prompt can
fix that, because no draft can see what the last three posts did. So the run
records the device on the post that ships and hands the count back on the next
one, and section 16 says what to do with it.

Cost, both halves stated separately, which is what the @14 to @15 note in
this file exists to enforce.

INPUT: +3,412 prompt characters (101,623 to 105,035) or about +850 tokens,
about +$0.002 an attempt, paid on every run because the prompt file is one
file. The `deviceSteer` FIELD is another ~380 characters when it is present,
and it is absent on nearly every run today.

OUTPUT: unchanged at worst, and lower on the plates this is about. Neither
change adds a field, a per-slide object or anything else that scales with the
slide count. Section 7 CAPS what a plate may carry, so a `list_takeaway` that
used to run to a hundred words now runs to sixty; section 16 changes which
shape a line takes, not how many lines there are. `STEP_COST_ESTIMATES_USD`
is therefore untouched, and that is a claim rather than an omission: a v26
attempt costs about $0.002 more than a v25 one and never less than v25 minus
the words it stops the writer from writing.

# Instagram Copy Craft Guide, v25

**What changed at v25.** Everything v24 says still stands. Section 22's
`subject.noun` gains the rule that its three examples all broke.

Three prep carousels of 2026-09-18 each illustrated a WORD from their own
headline rather than the thing the slide was about: a pocket watch under "two
clocks run your marketing", a lit doorway under "buyers open their window". It
is the oldest failure in stock photography and this guide caused it, by asking
for a concrete indexable noun and saying nothing about which noun.

Cost: about +1,300 characters, about +330 tokens, about +$0.001 an attempt.

# Instagram Copy Craft Guide, v24

**What changed at v24.** Everything v23 says still stands. One section, 22.

Two prep carousels shipped on 2026-09-18 with two pictures and none, both
having opted out on six slides of eight, and section 22's cost clause never
fired once: it exempts every archetype in the set, so `"none"` was free. The
pipeline backfills those slides now, so the post is no longer what is at
stake. What is at stake is WHICH picture, and a scene you briefed always
beats one derived from your headline by code.

Section 22 also names the bounded band for the first time. A picture does not
have to be the background, and the register where it sits inside the plate
beside the type is the one no carousel has shipped yet.

Cost: about +2,000 characters, about +500 tokens, about +$0.0015 an attempt.

# Instagram Copy Craft Guide, v23

**What changed at v23.** Everything v22 says still stands. Six changes, all
answering the same thing: the owner's own Instagram specification, read
against what this guide was actually telling you to write.

1. Section 2's hook is **one hundred characters, counted**, not "twelve words
   at most", and it may not open on an emoji, an `@` or a `#`. All three are
   refused mechanically.
2. Section 2 asks for **lines, not paragraphs**: one idea to a line, thirty
   words a line as a wall, two emoji in the whole caption. A caption that is
   only a bullet list is refused. **Arrow bullets are refused too**, and the
   engine strips the marker from any line that opens on one: see section 2.
3. Section 2 asks for the topic's own phrase in the first line, and says
   plainly that the check on it REPORTS rather than refuses.
4. Section 7 adds **slide 2 is a second cover**, because Instagram re-serves a
   carousel starting there for a reader who did not swipe.
5. Section 10 names three tells a phrase list cannot catch: the rule of
   three, "Let's" and "Imagine" as openers, and "journey" as a metaphor.
6. Two new sections. Section 29 is `hookPattern`, a required declaration of
   which of four shapes your hook is. Section 30 is which ASK to use, and the
   one condition on the strongest of them.

**Cost.** INPUT: about +5,800 prompt characters, about +1,460 tokens, about
+$0.0044 an attempt. OUTPUT: `hookPattern` is one enum value, so about +5
tokens a draft, which is nothing against the ceiling section 5 measures.

**What changed at v22.** Everything v21 says still stands. Two additions, both
about the PICTURE, and both answering the same measured verdict: on the last
set of real runs the owner looked at three finished posts and said the pictures
were generic, and one slide's six candidates were all refused because its brief
asked for a mood rather than a thing.

1. Section 22 adds **`subject`** to `visualNeed`: the concrete noun a photo
   library actually indexes, at most three things that must be visible, and,
   when the slide is about a real named thing, an `entityRef` naming it.
2. Section 6 adds **`namedEntities`**, the entities this run's own evidence
   names and corroborates, and section 16 adds **`sceneSteer`**, what your last
   attempt's briefs got wrong. `sceneSteer` never causes a redraft; it rides one.

**Cost.** INPUT: about +3,100 prompt characters, about +780 tokens, about
+$0.0023 an attempt. OUTPUT: about +40 tokens a slide for `subject`, well
inside the ceiling section 5 measures against.


**What changed at v21.** Everything v20 says still stands, and section 20 is
rewritten. Four changes, three of which make what you send back SMALLER.
Section 20 no longer asks you for markup: you describe the design in
`customArchetypeBrief` and a separate step builds it. Section 5 says where the
schema's hard length wall is for every field, so you never meet it. Section 7
gains `unfillable`, the field an archetype's missing object is named in
instead of being narrated to the reader, and tightens the cover to one subject
and no furniture. All four answer one measured fact: on the last set of real
runs, five of six redrafts died at the output ceiling before finishing, the
run silently re-judged an earlier draft, and the post shipped degraded. The
ceiling is raised in the same change. This file is the half that keeps what
you send back inside it.

**Cost, both halves, separately, because they move for different reasons.**
INPUT: +4,415 prompt characters (78,829 to 83,244, counted in characters
with line endings normalised so the figure does not move with a checkout),
about +1,104 tokens, about +$0.0033 an attempt, paid on every run in
every language because the prompt file is one file. Section 20 gives back 805
characters; the three rule additions and this ledger spend 5,220. OUTPUT:
the `customArchetype` markup block is removed from this step schema outright.
None of the six runs measured emitted one, so the MEASURED output saving is
$0.000 and it is stated that way rather than claimed; what moved is the worst
case, from an uncapped record plus 8,000 characters of markup (about 2,200
tokens on a single slide) to a brief of about 60 tokens. `unfillable` is
optional, is one short sentence on the rare slide that needs it, and was
emitted zero times in 61 measured slides. The design step that now writes the
markup is priced on its own at $0.030, at most once per carousel and only when
a draft asks for one.

**What changed at v19.** Everything v18 says still stands. v19 adds ONE
section, §29 "Your series": when the input carries a `seriesDirective`, the
layout of every slide is already decided and §7's layout MENU does not apply
, every other rule in §7, including what each archetype requires, applies
exactly as before. It is additive and it fails open: a run with no
`seriesDirective` reads identically to v18.

**What changed at v18.** Everything v17 says about VALUE still stands, unchanged
and in full. v18 adds ONE section, §28 "Marking": the writer names the spans
whose MEANING carries a slide, as a flat list of words copied verbatim out of
the slide, and the renderer paints them. It is additive. No v17 section is
edited, no field is removed, and `emphasis` is OPTIONAL on every slide, so a
draft written to v17 is still a valid draft here.

**What changed at v17.** This guide is rewritten around VALUE. The question
nothing here used to ask was not "is this correct" but "would anyone keep
it". §2 makes the caption three jobs in one string, §3 makes the slide count
follow the structure, §5 makes every slide one claim plus what follows from
it for the reader, §12 adds `payloadKind`, §16 adds `valueSteer`, and four
sections are new: §24 the payload and the named specific, §25 taking a
position, §26 rhythm, §27 the ban on reproducing a source's prose. A judge
now reads the finished post against four questions and returns a draft it
cannot find answers to, with the fixes named.

**Cost, both halves, separately, because they move for different reasons.**
INPUT: +16,301 prompt characters (45,805 to 62,106, counted with line
endings normalised so the figure does not move with a checkout), about
+4,075 tokens, about +$0.0122 an attempt, paid on every run in every
language because the prompt file is one file. OUTPUT: one new enum field,
`payloadKind`, about +10 tokens, about +$0.00015 an attempt. Nothing else in
the output grows, and that is deliberate: §5's so what lives inside `body`,
which already existed, and the caption's three jobs are structure inside the
one `caption` string rather than three new fields, so neither costs a token
per slide. `STEP_COST_ESTIMATES_USD.copyAttempt` is re-priced 0.161 to
0.174 in the same commit, which is the rule `run-budget.ts` states about
itself. RFC-18 §7.1 estimated this bump at +6,000 characters and +$0.0045
and priced `copyAttempt` at 0.166; the file the model is actually sent is
larger than the estimate, so the measured number is used here and the
estimate is corrected rather than quietly inherited. The @14 to @15 bump
recorded the opposite error, an output-heavy change priced on its input
alone and under-counted by nine tenths, so both sides are counted here even
when one is nearly zero.

You are writing the caption and the slide-by-slide copy for one Instagram
carousel post, for one client, for one run. This is the complete craft
policy for that copy: structure, sourcing discipline, and compliance. The
gates that check your work afterward (step 07's self-check: banned
words/characters, required compliance framing) enforce a subset of these
rules mechanically, but the judgment calls below are yours.
