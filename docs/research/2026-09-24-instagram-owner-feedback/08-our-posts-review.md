# The eight posts that were reviewed

Tomer's runs of 23–24 September were dispatched straight into the prep engine, not through the portal. Their records are in the prep Firestore collection `agentEngineRuns`, but no portal job points at them, so they never appeared on the calendar. On those two days: 33 such runs across 7 clients, logging about $79 of model cost (no client credits charged). Slide images live at `gs://karoscmo-prep-media-assets/instagram/<client>/<runId>/slide-N.png`. The render step's output (`08-render-carousel-attempt-N`) holds 7-day signed links, and `tools/harvest.cjs` plus `tools/build_review.py` rebuild the review sheet from them.

| Code | Client | Run | Status | Cost |
|---|---|---|---|---|
| A | KAROS Labs (Spotify Wrapped) | pubsub-21254982994413907 | awaiting gate | $1.82 |
| B | KAROS Labs (agent delegation; the run in Tomer's Hebrew report) | pubsub-21254987466423505 | awaiting gate | $2.44 |
| C | The Pitch by Deel ("Six questions") | pubsub-21255292697877233 | completed | $0.98 |
| D | Geektime (single news image, Hebrew) | pubsub-21255132410207986 | completed | $1.30 |
| E | Hanky Panky | pubsub-20296546809871980 | completed | $1.08 |
| F | Kindly Yours (wrong business: wedding design) | pubsub-21255254988332367 | completed | $1.29 |
| G | Sitti | pubsub-21255328593979584 | awaiting gate | $2.06 |
| H | XO Digital (Portuguese) | pubsub-21255292697884248 | awaiting gate | $2.33 |

## Defects found in the renders

- **F7 and F8 are byte-identical files.** The copy had 8 distinct slides; "Most wedding designs are built around aesthetics" never rendered, and the old closer stayed in storage as slide 8 (see WS-09).
- **G ends on two closers** ("Audience size is 25% of the decision"), and "The test has a standard length" is missing. Same mechanism.
- **F is about the wrong business.** kindlyyours.com is a parked for-sale domain; the brand is thisiskindly.com.
- **Fonts that actually rendered:**
  - KAROS: Spectral and Hanken Grotesk (correct, but with synthetic bold).
  - Deel, Sitti and XO: the engine's default Space Grotesk and Inter.
  - Hanky Panky: Georgia and Helvetica Neue.
  - Kindly Yours: Plus Jakarta Sans and Inter.
  - Geektime: Heebo, Rubik and Inter (its brand face is Open Sans).
  - Every client: a mono role declared IBM Plex Mono and painted in DejaVu Sans Mono.
