# Instagram owner feedback round, 24 September 2026

Albert reviewed Tomer's latest Instagram runs (8 carousels, 7 clients) and gave a long feedback round. This folder holds everything that round produced: the feedback and its consequences, root causes in the code, a build plan, and a research study behind the design rules. Engine code comes next, as commits on this branch.

| File | What it is |
|---|---|
| [09-architecture-conclusions.md](09-architecture-conclusions.md) | **Start here for the system.** What the research concludes, the layer architecture (platform / thin middle of cards / client DNA), the loops that make it compound, the impact on today's code by repo, build order, cost, and the owner's open decisions. |
| [01-owner-feedback-and-consequences.md](01-owner-feedback-and-consequences.md) | Every feedback point, its root cause, what changes, the workstream, and the decisions Albert still needs to make. |
| [02-build-plan.md](02-build-plan.md) | 13 workstreams (WS-01..WS-13), files, tests, overlap with open PRs, data fixes, and the drift review against the brief. |
| [03-code-audit.md](03-code-audit.md) | Seven auditors' findings with file:line references: fonts, design language, typography and covers, logo, duplicate slides, copy language, graphics. |
| [04-layer-system.md](04-layer-system.md) | How the L1 platform / L2 industry / L3 client system should work: judged across three designs, with what to build now. |
| [05-benchmark-study.md](05-benchmark-study.md) | 87 competitor and benchmark accounts across 7 clients, tagged within-account (best vs weakest posts of the same account), with per-client syntheses and 105 cross-industry transfer candidates. |
| [06-a16z-deep-dive.md](06-a16z-deep-dive.md) | 72 @a16z posts measured slide by slide, the playbook for The Pitch by Deel, and a critique of our Pitch carousel. |
| [07-don-techno-audit.md](07-don-techno-audit.md) | What the bespoke Don Techno system does that the engine doesn't, plus 13 music-media accounts tagged as a 7th industry. |
| [08-our-posts-review.md](08-our-posts-review.md) | The eight reviewed runs, the defects found in their renders, and how to rebuild the review sheet. |
| [guidelines/](guidelines/README.md) | The compiled guideline set: L1 platform rules and parameters, facet cards (archetype, involvement, locale), eight category packs, and one client DNA for each of the 9 clients. `_src/` is the single source; `render.py` regenerates everything with budget checks. |
| `evidence/` | The data behind the conclusions: within-account statistics over 183 accounts, the grouping tests (89 and 173 accounts), the taxonomy study, the storm's surviving and refuted conclusions, the four system designs, and the 108 audited rows. |
| `tools/` | The research scripts: ScrappyCoco wrapper, scale tables, review-sheet builder, and the next workflows (taxonomy study, layer auditors, compile). |

## Headline findings

- **Duplicate slides are a storage bug, not a writing bug.** Renders overwrite `slide-N.png`, so a shorter re-render leaves the old last slide behind (Kindly 7 and 8 are byte-identical).
- **Fonts are guessed at onboarding for 5 of 7 clients.** No template role loads its declared face, and the check that "proves" a font loaded reports the requested name.
- **Within-account statistics across 87 accounts** (one vote per account):
  - Photo-led covers win (39 accounts vs 15, p=0.002).
  - 4+ text sizes lose (25 vs 10, p=0.02).
  - Boxes and cards lose (28 vs 13, p=0.03).
  - "Link in bio" CTAs lose; comment prompts win.
  - Story hooks and complete or mixed sentences win; fragments lose.
- **@a16z:** carousels do the work. The breakouts are archival "then" stories and one-line manifestos. Type is two sizes plus a meta line, covers carry ≤ 10 words, photos behind text are darkened, and carousels end on the idea, not a CTA card.
- **Layer system:** scope comes from where evidence repeats, not from who said it. Most feedback on a post is a defect and belongs in code. Industry kits are parameter sets. Benchmark accounts, not clients, are the replication unit for now.

## Not done yet (next session)

- **Wave 1 code** (fonts, set integrity, site identity, parameter table). It was started and paused; its partial diffs are kept locally in `~/Karos-research/2026-09-24-instagram-feedback-round/wave1-partial-diffs/`.
- **The storm's lead synthesis and skeptic pass,** the layer auditors (every finding classified to a layer, with per-client extent and cross-industry transfers), and the taxonomy study (industries vs client types vs facets). All scripts are in `tools/`.
- **A local re-run of the agent** after the code lands.

The raw scrape (about 700 MB: posts, covers, carousel slides) is kept locally in `~/Karos-research/2026-09-24-instagram-feedback-round/research/`. It is not committed.
