/**
 * `parse_ts` (triage.py): accepts both `"...Z"` and naive (zoneless) ISO
 * timestamps — a `manual_export` leg can emit zoneless times. Naive
 * timestamps default to UTC so aware/naive never mix and abort.
 *
 * JS's `Date` constructor does the OPPOSITE of Python's `datetime.fromisoformat`
 * for a zoneless string: ECMA-262 treats a date-time string with no offset as
 * LOCAL time, not UTC. This function corrects that divergence explicitly —
 * a string with no `Z` and no explicit `+HH:MM`/`-HH:MM` offset gets `Z`
 * appended before parsing, exactly matching Python's naive-defaults-to-UTC rule.
 */
export function parseTs(value: string): Date {
  const hasOffset = /Z$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value);
  const normalized = hasOffset ? value : `${value}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`triage: unparseable timestamp "${value}"`);
  }
  return date;
}
