const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parses a freshness window like "24h", "7d", "30m", "45s" into milliseconds. */
export function parseDurationMs(window: string): number {
  const match = /^(\d+)\s*(s|m|h|d)$/i.exec(window.trim());
  if (!match) {
    throw new Error(`invalid duration window "${window}" — expected e.g. "24h", "7d", "30m", "45s"`);
  }
  const amountStr = match[1];
  const unit = match[2];
  if (!amountStr || !unit) {
    throw new Error(`invalid duration window "${window}"`);
  }
  return Number(amountStr) * UNIT_MS[unit.toLowerCase()]!;
}
