/**
 * A picture recovered from the media bucket after a resume comes back under a
 * name `media.ingestAssets` derives from the slot alone (`n<slot>-client0`),
 * so two different pictures recovered for the same slot in two attempts share
 * one path. The path-keyed kind sets (mark, clear mark, cutout) must describe
 * the picture NOW at that path, not the one that held the name before.
 *
 * Prep `pubsub-21255083755108745` (XO Digital, 2026-09-25): attempt 1 put the
 * CVM logo on slide 2 and a resume recovered it as `n2-client0.png`, which
 * joined the mark set. Attempt 3 chose a stock photograph for slide 2, a
 * second resume recovered it to the same path, and the stale mark entry set a
 * photograph as a 150px logo card in the middle of a list slide.
 */
export function carryImageKinds(from: string, to: string, kinds: ReadonlyArray<Set<string>>): void {
  for (const set of kinds) {
    if (set.has(from)) set.add(to);
    else set.delete(to);
  }
}
