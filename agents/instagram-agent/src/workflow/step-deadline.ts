/**
 * A deadline for a tool call that must not hold a run forever.
 *
 * Prep batch 8 (2026-09-26): Geektime's `05b-source-images-attempt-3` stayed
 * `running` for over fifty minutes while the worker kept renewing the run's
 * lease, so neither a redelivery nor the orphan sweep could take it over. The
 * step's measured duration across batches 6-8 is a median of 7s and a maximum
 * of 41s (68 steps). A call past its deadline resolves to `onTimeout()`,
 * which the caller shapes like the tool's own non-success result so the run
 * takes the path it already survives (an outage: slides degrade, the post
 * ships, the reason is recorded). The abandoned call is not cancelled; it can
 * only finish into nothing.
 */
export async function withinDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** `05b-source-images`: over four times the slowest step measured in batches 6-8 (41s). */
export const SOURCE_IMAGES_DEADLINE_MS = 3 * 60 * 1000;
