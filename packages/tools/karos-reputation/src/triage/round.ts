/**
 * Python 3's `round()`: round-half-to-even (banker's rounding), not
 * round-half-up. `triage.py` calls `round()` at three points (recency
 * multiplier to 4 places, rating-window average and dip delta to 2 places,
 * the final value score to 0 places) — JS's `Math.round` is round-half-up
 * and would silently diverge from Python on an exact .5 tie.
 *
 * **Why this is a decimal-string implementation and not `value * 10**n`.**
 * The obvious port (scale, inspect the fractional part, unscale) is wrong,
 * not merely slow: the scaling multiply is itself a lossy floating-point
 * operation, so it can move a value ACROSS a rounding boundary the true
 * (unscaled) binary double was never near. Python's `round(x, n)` operates
 * on the exact binary value of `x`, never on a scaled proxy. The canonical
 * reproduction: `43/40` is the double
 * `1.0749999999999999555910790149937...`, so Python answers `1.07`; but
 * `1.0749999999999999555… * 100` rounds UP to exactly `107.5` in binary,
 * and a half-to-even tie-break on `107.5` then answers `1.08`. One lossy
 * multiply, one wrong crisis verdict (`detect_rating_dip`'s 0.3 delta).
 *
 * So: get the exact-enough decimal expansion of the double via `toFixed`
 * (which ECMA-262 §21.1.3.3 defines in terms of the actual stored value, not
 * a fresh multiply), decide the rounding direction by inspecting decimal
 * digits, and reconstruct with BigInt arithmetic so no intermediate step can
 * reintroduce the very precision loss this function exists to avoid.
 */
export function pyRound(value: number, ndigits = 0): number {
  if (!Number.isFinite(value)) return value;

  // `toFixed` switches to exponential notation at 1e21, and every double of
  // that magnitude is already an integer far coarser than any digit position
  // we could round to — rounding is the identity there.
  if (Math.abs(value) >= 1e21) return value;

  const n = Math.trunc(ndigits);
  const negative = value < 0 || Object.is(value, -0);

  // 20 digits of headroom past the rounding position is far more than enough
  // to tell a true tie from a near-tie: consecutive doubles near a value `v`
  // differ by ~v * 2.2e-16, so a decimal that agrees with the tie point to
  // 20 extra places IS the tie point. `toFixed` caps at 100 fraction digits.
  const precision = Math.min(100, Math.max(0, n + 20));
  const fixed = Math.abs(value).toFixed(precision);
  const dot = fixed.indexOf(".");
  let intPart = dot === -1 ? fixed : fixed.slice(0, dot);
  const fracPart = dot === -1 ? "" : fixed.slice(dot + 1);

  // Negative `ndigits` rounds to tens/hundreds/… (Python allows it). Pad the
  // integer part so the cut position below is always at least 1, which keeps
  // the digit-slicing arithmetic uniform for every sign of `ndigits`.
  if (n < 0) {
    const need = -n + 1 - intPart.length;
    if (need > 0) intPart = "0".repeat(need) + intPart;
  }

  const digits = intPart + fracPart;
  const cut = intPart.length + n;
  const kept = digits.slice(0, cut);
  const rest = digits.slice(cut);

  let roundUp = false;
  if (rest.length > 0) {
    const first = rest.charCodeAt(0) - 48;
    if (first > 5) {
      roundUp = true;
    } else if (first === 5) {
      const tail = rest.slice(1);
      if (/[1-9]/.test(tail)) {
        roundUp = true; // strictly past the midpoint
      } else {
        // An exact tie — and only here does Python's half-to-EVEN rule apply.
        const lastKept = kept.length > 0 ? kept.charCodeAt(kept.length - 1) - 48 : 0;
        roundUp = lastKept % 2 === 1;
      }
    }
  }

  // BigInt, never `+ 1` on a float: `kept` can be longer than 2^53 for a
  // large value rounded to many places, and a float increment there would
  // silently do nothing.
  let magnitude = BigInt(kept === "" ? "0" : kept);
  if (roundUp) magnitude += 1n;

  let decimal: string;
  if (n <= 0) {
    decimal = magnitude.toString() + "0".repeat(-n);
  } else {
    const padded = magnitude.toString().padStart(n + 1, "0");
    decimal = `${padded.slice(0, padded.length - n)}.${padded.slice(padded.length - n)}`;
  }

  // `parseFloat` of a decimal literal is the correctly-rounded double for that
  // literal (ECMA-262 §7.1.4.1), which is exactly what Python's `round` returns.
  // `-0` falls out naturally from the sign prefix; no special case needed.
  return Number.parseFloat(negative ? `-${decimal}` : decimal);
}
