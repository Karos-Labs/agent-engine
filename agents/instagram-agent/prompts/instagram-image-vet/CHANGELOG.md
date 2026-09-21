# Instagram Image Vetting Craft Guide  — release history

Read by people, not by the model. These blocks used to sit at the top of the
prompt, so every call paid to read a description of edits to sections the
reader was about to reach anyway.

---

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

