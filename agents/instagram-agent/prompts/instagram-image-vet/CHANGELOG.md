# Instagram Image Vetting Craft Guide  — release history

Read by people, not by the model. These blocks used to sit at the top of the
prompt, so every call paid to read a description of edits to sections the
reader was about to reach anyway.

---

**What changed at v10 (2026-09-24).** Everything v9 says still stands. Section 2
gains one exception: a publisher's own article photograph (`PUBLISHER-OWNED
editorial image`, from `media.harvestArticleImages`) is `editorial-only` and
`rightsUsable: true` WITH A CREDIT, when no candidate with a verified licence
passes the floor for that slide. The owner's ruling, after two prep posts
(KAROS, Geektime) shipped with zero pictures: *"not everything has to be AI
images; harvested images with a credit are part of what can appear"*, and,
asked whether that includes unknown-licence news photos: *"yes, with credit"*.
Social-network scrapes stay refused. `license` is written as
`Publisher-owned editorial image, credit "<domain>"` so `creditLineFor` can
print `Photo: <domain>` under the picture.

Cost ledger: INPUT +~230 tokens per vet call (one paragraph); OUTPUT flat.

---

**What changed at v9.** Everything v8 says still stands. Section 1b gains one
paragraph after its worked cases: a real photograph of the subject beats the
subject's logo. The entity route now labels its logo-rung candidates
(`MARK_CANDIDATE_TAG`), and on 2026-09-23 a karoslabs carousel
(`pubsub-21947180423151342`) showed why the rule was needed: the pool held a
photograph of an Anthropic speaker and the Anthropic wordmark, and v8's "a logo
is the least ambiguous possible picture of a company" picked the wordmark. The
owner: every slide looked AI-generated and generic, and the real pictures were
missing.

**Cost.** INPUT: about +720 prompt characters, about +180 tokens, about
+$0.0005 a call. OUTPUT: unchanged, $0.000.

**What changed at v8.** Everything v7 says still stands, unchanged. The v7
release-history block moved out of the prompt and into this file; the guide's
body is byte-identical.

**Cost.** INPUT: about -1,200 prompt characters, about -300 tokens, about
-$0.0009 a call. OUTPUT: unchanged, $0.000.

# Instagram Image Vetting Craft Guide — v7

**What changed at v7.** Everything v6 says still stands. Section 1b gains the
distinction it was missing, and section 1d is new.

A slide's claim usually contains two different things: a SUBJECT it names, and
a PROPOSITION it asserts about that subject. `claimMatch` was being scored
against the proposition. On 2026-09-20 two prep carousels shipped with one
picture and zero pictures between them, and the refusals read *"lacks the
required conversation interface and the 'sponsored' label central to the
slide's claim"* — on a slide asserting that ChatGPT **will show** sponsored
ads inside conversations. No photograph can be evidence for a sentence about
the future. The pool had two Wikimedia pictures of ChatGPT and a Pexels shot
of the ChatGPT interface, and all of them were thrown away.

The owner: *"demanding forensic evidence for a future claim instead of
accepting a high subjectMatch is unacceptable... a picture relevant to the
subject is far better than leaving a slide completely empty."*

Cost: about +7,054 characters, about +1,760 tokens, under +$0.002 a vetting
call. INPUT only. OUTPUT is unchanged — no new field, nothing per-candidate.

