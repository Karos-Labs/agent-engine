# Instagram Art Direction Guide — release history

Read by people, not by the model.

---

**What changed at v3.** Everything v2 says still stands. Section 3's `subject`
gains one paragraph: the feed's cliché scenes are never a client's subject,
and screens stay out of `light`, `lines` and the `styleLock`.

The karoslabs direction v2 derived on 2026-09-18 made the cliché the brand:
its subject was "a founder or growth lead alone at a cluttered desk, focused
on a laptop screen", a line said "one person at work alone ... at a laptop in
a dim room", and its style lock was "night-operator-35mm" with a screen glow as
the key light. Every generated frame inherited it; on 2026-09-23 a stopwatch
and a desk calendar were briefed and a man at a laptop in a dark room was
drawn. The owner named that scene as the reason the posts looked generic.
`buildArtDirection` now drops such lines in code as well.

**Cost.** INPUT: about +900 prompt characters, about +225 tokens, about
+$0.0007 a derivation (once per client per 90 days). OUTPUT: unchanged, $0.000.
