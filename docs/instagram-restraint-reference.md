# The restraint reference — what professional marketing carousels actually do

Harvested 2026-09-14 via ScrappyCoco, at the owner's instruction after he read a real prep render
(`pubsub-21839432908803804`) and said: *"the templates had too many effects and designs that are hard
to look at, it did not look professional at all… you should have looked at posts that are considered
really good out there and taken inspiration."*

**This is a different reference set from [`instagram-quality-reference-accounts`].** That one
(`@reputeforge`, `@alex.snippet`, `@karoslabs`) is the owner's ground truth for **craft and writing**.
This one is the bar for **restraint**: accounts that ship the same format we do — a text-led marketing
carousel — and look like a professional made them.

Sources: `@semrush`, `@buffer`, `@hubspot`, `@pentagramdesign`, `@koto_studio`. `@marketingexamined`,
`@demandcurve` and `@later.com` failed in ScrappyCoco; `@thefutur` posts artwork rather than editorial
carousels and is not usable for this.

---

## The two plates that settle it

**`@semrush`, "You saw the conversion."** One flat near-black ground. No texture, no gradient, no
field, no numeral. Headline and sub-head both ranged left, two sizes. The only colour on the plate is
in a **diagram**: four circular badges — ChatGPT, Google Search, Review sites, Email/Ad — each with a
pastel fill and a matching curve running off the right edge to a convergence point. One arrow, bottom
left. Nothing else. **The entire lower-left quadrant is empty and nobody filled it.**

**`@buffer`, "A pipeline that turns community questions…"** One flat deep-green ground carrying a
pixel-block texture **at almost exactly the ground's own value** — present, and only just visible —
plus five small pastel squares as sparse punctuation. Mono kicker, display headline, name, role: all
ranged left. A cut-out portrait bleeding off the bottom-right corner. No rules, no bars, no badges, no
watermark, no slide index.

## The rules they share

1. **One ground per post, flat.** Texture only at near-ground value. Never a field you can read as a
   pattern.
2. **Everything ranged left.** No centred body copy anywhere, in either account, on any slide.
3. **Two or three type sizes.** Not five.
4. **Colour is information or punctuation — never a surface.** Semrush's colour IS the four channels;
   Buffer's is five small squares. Neither paints a panel.
5. **One subject that means something**: a real diagram, or a real photograph. Not an ornament.
6. **Large quiet regions, left alone.**
7. **No furniture on the cover.** No source credit, no slide index, no watermark, no eyebrow AND
   kicker, no rules.

**Count the element groups: three or four.** The prep render that prompted this had **nine** on its
cover, three of which said the same sentence.

## The finding that matters most

**Both reference plates would fail our interest floor.** Semrush's empty lower-left is a large
contiguous hole — a `dead-space` finding — and on our system the free re-layout planner would "fix" it
by attaching a device. On the run the owner read, that is exactly what happened, and the device it
fabricated was the digit `2` pulled out of the word `B2B`, labelled with the claim minus that digit,
and sourced to `salesforce.com`.

So the floor does not merely tolerate our over-decoration: **it demands it, and then manufactures
content to satisfy itself.** RFC-20 §11.3 recorded the same thing from the other side — seven of eight
templates could not clear the floor without a paint layer covering for them.

This is the strongest argument yet for RFC-21 Part 2's unfinished work, and it reframes it: the
question is not only "can the floor tell deliberate emptiness from neglect" but "**is a floor that
rewards ink the right instrument at all**".

## ── MEASURED, AND IT CHANGED THE CONCLUSION (CI 34861097819) ──

The texture reduction above was pushed and the calibration sweep measured it. **It failed, and the
failure is the most useful result in this document.**

The one-line plate across four palettes, before and after quieting the full-plate hairline from 22% on
a 9px period to 8% on 14px:

```
                         occ      flat     verdict
before   bundled dark    0.5094   0.7666   pass
after    saturated blue  0.1315   0.8399   FAIL empty
after    on the 4.5:1    0.1300   0.8660   FAIL empty
```

**Occupancy fell from 0.51 to 0.13 because the texture WAS the occupancy.** Roughly 38 of those 51
points were the dot field, not the type.

Two consequences, and the second is the important one.

**First, it corrects a conclusion recorded in RFC-21 §2.7.** That section says a confident one-liner on
our templates is a high-occupancy plate that already clears every floor, and concludes the owner's
"deliberate emptiness" case is *not reproducible on our own templates*. That reading was measuring the
decoration. With the decoration quieted the same plate fails clause D on every palette. **The case IS
reproducible; it was hidden by the paint.**

**Second, the floor is what holds the decoration in place.** `slide.html` heroless, `closer.html` in
Hebrew, the marked-emphasis case and the whole gate-zero sweep all went red on a change that only
lowered a texture's opacity. That is RFC-20 §11.3's "seven of eight templates cannot clear the floor
without a paint layer" demonstrated from the other direction: remove the paint and they do not clear
it.

So the restraint this document describes **cannot be implemented while `occupiedShare` gates**, and the
number must not simply be lowered to let it through — that is the move this project has refused all
along, and lowering it to fit a plate is how the instrument became overfitted in the first place.

The template changes are therefore REVERTED in this branch. What shipped is the half that does not
depend on the floor. The next piece of work is the floor itself, and RFC-20 §5.6 rule 3 already names
the shape: demote clause D's occupancy limb to reporting-only and let clause C, clause G and the value
gate carry the refusal.

## What was changed on the strength of this

See the commit *"Stop fabricating statistics, and stop randomising alignment"*: the word-boundary
guard on figure extraction, alignment withdrawn to `start`, and one ground per post. None of the three
touches a pixel budget, which is why they survive.

The two that did — the ghost numeral at 460px/16% and the full-plate textures at 8%/14px, which is the
Buffer treatment arrived at independently — are **reverted**, for the reason measured above. They are
right, and they are not shippable until the floor stops requiring the ink they removed.

## What is NOT changed, and should be measured before it is

The panel-scoped hairline fields at 12% (`comparison-card`, `closer`, `stat-callout`) are contained
rather than full-plate. The comparison card's accent panel reads muddy on a dark ground — the accent
at partial opacity over `#17181C` is a brown, not the brand orange — and that is worth fixing, but as
a colour derivation rather than by eye. The calibration sweep is the instrument; do not tune either by
looking.
