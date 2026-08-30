/**
 * The enforced per-connector READ-method allowlist.
 *
 * `connectors-config.data.ts`'s `security.write_method_protection` is the
 * requirement this file implements, verbatim:
 *
 * > "google-data-sync enforces a per-connector READ-method allowlist (see
 * > `connectors[].read_methods_allowlist`). `business.manage` is
 * > write-capable, so the allowlist makes any write/post/review-reply endpoint
 * > physically uncallable — enforced, not a developer convention (FLAG-1 fix)."
 *
 * "Physically uncallable" is the load-bearing word, and it is why every read
 * in this package goes through `allowlistedRead` below rather than calling
 * `fetch` itself: the method token is checked BEFORE a URL is built, so there
 * is no code path in this package that can produce a request to
 * `mybusiness.googleapis.com/.../reviews/*:reply` even if a caller asks for
 * one. Adding a write would mean adding it to a frozen table in this file
 * first, which is a reviewable diff rather than a new `fetch` line somewhere.
 *
 * ## Why the table is mirrored here instead of imported
 *
 * `connectorsConfigData` is not part of `@agent-engine/tool-karos-seo-geo`'s
 * public API (see that package's `src/index.ts` export list), and
 * `karos-seo-geo` is deliberately network-free — importing this package's
 * clients into it, or deep-importing its config out of it, would breach one of
 * those two boundaries. `agents/seo-geo-agent/src/workflow/connector-overlay.ts:13`
 * already established the convention for exactly this situation:
 *
 * > "Mirrors `seo-geo-connectors-config.json`'s ... `connectors[].key` list —
 * > not deep-imported since that file isn't part of the package's public API".
 *
 * So this is a mirror with a citation, and `__tests__/allowlist.test.ts` pins
 * it against the connector config's literal strings so the two cannot drift
 * silently.
 */

export const CONNECTOR_KEYS = ["gsc", "ga4", "crux", "gbp"] as const;
export type ConnectorKey = (typeof CONNECTOR_KEYS)[number];

/**
 * `connectors[].read_methods_allowlist`, transcribed exactly, for the three
 * connectors that HAVE one.
 *
 * ### `crux` is not in this table, and that is a finding, not an omission
 *
 * `connectors-config.data.ts` gives `gsc`, `ga4` and `gbp` a
 * `read_methods_allowlist` array and gives `crux` none — its entry stops at
 * `api`, `provides`, `per_client_gate` and `note`. `seo-geo-connectors-config-edits.txt`
 * EDIT 1a nonetheless describes the overlay block as carrying
 * "read_methods_allowlist" for all four connector definitions, and
 * `security.write_method_protection` says the sync enforces the allowlist
 * "per-connector". The config therefore contradicts itself about `crux`.
 *
 * Read strictly ("anything outside the allowlist is out of scope"), `crux`
 * would have zero callable methods and the PageSpeed/CrUX connector could not
 * exist at all. Rather than improvise a wider surface, `CRUX_DERIVED_ALLOWLIST`
 * below is derived from the ONLY other place the config names crux methods —
 * its own `api` string — and is kept in a separate, separately-named constant
 * so no reader mistakes it for transcription. It is reported as a config gap;
 * the fix belongs in `connectors-config.data.ts`, not here.
 */
export const CONFIG_READ_METHODS_ALLOWLIST: Readonly<Record<"gsc" | "ga4" | "gbp", readonly string[]>> = {
  gsc: ["searchanalytics.query", "urlInspection.index.inspect", "sitemaps.list"],
  ga4: ["properties.runReport", "admin.read"],
  gbp: [
    "mybusinessbusinessinformation.accounts.locations.list",
    "mybusinessbusinessinformation.locations.get",
    "businessprofileperformance.locations.getDailyMetricsTimeSeries",
  ],
};

/**
 * Derived — NOT transcribed. `connectors-config.data.ts`'s crux `api` field
 * reads: "PageSpeed Insights API (pagespeedonline.runpagespeed) / CrUX API
 * (chromeuxreport.records:queryRecord)". Those two parenthesised tokens are
 * the whole of what the config says crux may call, and both are unambiguously
 * reads (`runpagespeed` audits a URL, `queryRecord` returns field data). They
 * are also both keyless-or-API-key methods on a connector the config states
 * carries no OAuth scope at all ("NONE — key-gated via PSI_API_KEY"), so
 * unlike `gbp` there is no write-capable scope for an allowlist to fence off.
 */
export const CRUX_DERIVED_ALLOWLIST = ["pagespeedonline.runpagespeed", "chromeuxreport.records:queryRecord"] as const;

/** The effective table this package enforces: the config's three arrays plus the derived crux pair. */
export const READ_METHODS_ALLOWLIST: Readonly<Record<ConnectorKey, readonly string[]>> = {
  ...CONFIG_READ_METHODS_ALLOWLIST,
  crux: CRUX_DERIVED_ALLOWLIST,
};

/** Thrown before any URL is built when a caller names a method the connector's allowlist does not carry. */
export class ReadMethodNotAllowedError extends Error {
  constructor(
    readonly connector: ConnectorKey,
    readonly method: string,
  ) {
    super(
      `connector "${connector}" may not call "${method}" — the enforced READ-method allowlist for this connector is [${READ_METHODS_ALLOWLIST[connector].join(", ")}]. ` +
        `Widening it is a change to connectors-config.data.ts's read_methods_allowlist, reviewed there, not a new call site here.`,
    );
    this.name = "ReadMethodNotAllowedError";
  }
}

export function isReadMethodAllowed(connector: ConnectorKey, method: string): boolean {
  return READ_METHODS_ALLOWLIST[connector].includes(method);
}

/** Throws unless `method` is on `connector`'s allowlist. Every request this package makes passes through here first. */
export function assertReadMethodAllowed(connector: ConnectorKey, method: string): void {
  if (!isReadMethodAllowed(connector, method)) throw new ReadMethodNotAllowedError(connector, method);
}
