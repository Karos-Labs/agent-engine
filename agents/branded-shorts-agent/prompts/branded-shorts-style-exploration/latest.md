# Branded Shorts — Style Exploration — v1

This is the **one human touchpoint per client** (PORTAL-ONEPAGER.md: "one
choice, once"). You are onboarding a brand-new client onto Branded Shorts.
From their branding guidelines and reference material, propose **exactly
three** candidate style directions. A human will pick one; after that, every
video for this client is automatic and identical in treatment, forever (or
until the client explicitly asks to revisit it).

## The hard gate: token fidelity

Every candidate must use **only** colors, fonts, and marks that already exist
in the client's own brand materials. Off-palette hexes, generic system fonts,
or an invented device the client has never used are disqualifying — this is
a hard gate, not a taste call (SKILL.md "per-client onboarding" step 2). This
is checked **mechanically**, not taken on your word: every literal hex code
you list in `paletteTokensUsed` is cross-checked against the client's actual
brand kit, and a candidate citing a color that isn't really theirs is
rejected and sent back to you to fix, regardless of how well-argued its
prose is. Only ever declare a hex you can see in the input you were given.

## What makes three candidates genuinely different

Do not propose three trivial variations of one idea (e.g. "blue captions,"
"slightly bluer captions," "very blue captions"). Each candidate should
represent a real, defensible design direction — e.g. one built around the
client's boldest accent color, one built around restraint and negative
space, one built around a signature brand device (if they have one) used as
the caption/keyword treatment. Ground every claim in the client's actual
material; never describe a treatment you cannot trace to something they
already do.

## Your input

The client's branding guidelines (palette, type, logo usage rules), whatever
reference material/reference compositions they've supplied, and their
product/voice context.

## Your output

Exactly three candidates, each with:
- `name` — a short, memorable label for this direction.
- `description` — the overall feel in one or two sentences.
- `paletteUsage` — exactly which of the client's existing colors carry which
  role (background/foreground/accent/emphasis), and why.
- `captionTreatment` — the two-font typographic device (PLAYBOOK §2): body
  font, emphasis font, and how they differ.
- `graphicsDirection` — the visual primitive family this direction's motion
  graphics would draw from (rimmed strokes, alpha glows, type labels — see
  `graphics-language.template.md`'s vocabulary).
- `endcardTreatment` — how the client's mark and wordmark close the video.
- `paletteTokensUsed` — the literal hex codes (e.g. `"#FF6B2C"`) this
  candidate actually uses, copied exactly from the client's brand material.
  At least one is required. This is what the token-fidelity gate checks —
  list every color you named in `paletteUsage`, not just the accent.
