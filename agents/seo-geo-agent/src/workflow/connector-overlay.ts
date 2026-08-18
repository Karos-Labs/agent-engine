import type { SeoGeoConnectorOverlay } from "./types.js";

/** `seo-geo-connectors-config.json`'s source-ladder (RFC-04 §2 Phase 5): highest-accuracy source wins, terminal `UNAVAILABLE` is honest, never a fabricated zero. */
const CONNECTOR_SOURCE_LADDER = ["first_party_google", "measured_ai_capture", "research_estimate", "UNAVAILABLE"] as const;

interface KnownConnector {
  key: string;
  googleProduct: string;
  /** Named for operator legibility only — not read from any env var by this function (no live credential check is wired up in this environment yet). */
  credentialHint: string;
}

/** Mirrors `seo-geo-connectors-config.json`'s (`karos-seo-geo/src/config/connectors-config.data.ts`) `connectors[].key` list — not deep-imported since that file isn't part of the package's public API (see `karos-seo-geo/src/index.ts`'s export list). */
const KNOWN_CONNECTORS: readonly KnownConnector[] = [
  { key: "gsc", googleProduct: "Google Search Console", credentialHint: "GSC_SERVICE_ACCOUNT_KEY / GSC_SITE_URL" },
  { key: "ga4", googleProduct: "Google Analytics 4", credentialHint: "Google Analytics 4 OAuth credentials" },
  { key: "crux", googleProduct: "PageSpeed Insights / CrUX (field Core Web Vitals)", credentialHint: "PSI_API_KEY" },
  { key: "gbp", googleProduct: "Google Business Profile", credentialHint: "Google Business Profile OAuth credentials" },
];

/**
 * Phase 5 (RFC-04 §2/§4): the connector overlay is a source-ladder lookup,
 * never judgment. This environment has no Google OAuth/API credentials
 * configured at all — RFC-04 §4 names this exactly ("Classic-Google ranking
 * data is blocked on Search Console verification... this is an
 * infrastructure/credentials gap, not a design gap") — so every connector
 * reports honestly as not connected, never a fabricated first-party number.
 *
 * `karos-seo-geo`'s own `config/seo-geo-connectors-config-edits.txt` proposes
 * folding this ladder into an inline `google_overlay{}` scoring-config block
 * plus a 12->16 field extension of `reproducibility.hash_inputs`. That edit
 * is explicitly "GATED on Daniel's determinism sign-off, deliberately NOT
 * applied" (RFC-04 §4) — this function does not read, apply, or fold in any
 * of its contents; it only references the file by name below, exactly as
 * RFC-04 requires ("port it as a separate, clearly-labeled pending-change
 * file, not merged in").
 */
export function buildConnectorOverlay(): SeoGeoConnectorOverlay {
  return {
    sourceLadder: CONNECTOR_SOURCE_LADDER,
    connectors: KNOWN_CONNECTORS.map((connector) => ({
      key: connector.key,
      googleProduct: connector.googleProduct,
      connected: false,
      reason: `not connected in this environment (${connector.credentialHint} not configured)`,
    })),
    pendingConfigEdit: {
      file: "seo-geo-connectors-config-edits.txt",
      status: "GATED_NOT_APPLIED",
      note:
        "Proposed additive google_overlay{} scoring-config block and a 12->16 field extension of reproducibility.hash_inputs, GATED on Daniel's determinism sign-off per RFC-04 §4. Not applied by this workflow.",
    },
  };
}
