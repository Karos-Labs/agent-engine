import { z } from "zod";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";
import { accountsLocationsList, type GbpLocation } from "@agent-engine/tool-karos-connectors";
import { describeFetchFailure, fetchWithDeadline } from "../capture/http.js";
import { resolveGbpCredential, type GbpAccessTokenProvider } from "../capture/gbp-credential.js";
import type { ReputationFetchImpl } from "../capture/types.js";

// 1.1.0 (2026-09-06): `account` became optional — with none, the credential is
// asked which Business Profile accounts it manages and every one of them is
// enumerated; the credential itself now falls back to the deployment's ADC.
// Additive to the result (`accounts`, per-location `account`), so a caller
// that supplied an account reads the same shape it always did.
const TOOL_VERSION = "1.1.0";

/** Locations are paged; a real account has a handful, and this cap is only there so a runaway `nextPageToken` cannot loop a setup step forever. */
const MAX_PAGES = 10;

const ACCOUNT_MANAGEMENT_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1";

export const DiscoverGbpLocationsInputSchema = z.object({
  account: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The Google Business Profile account id (with or without the `accounts/` prefix) whose locations to list. Omit it to enumerate every account the credential manages — for a service account, exactly the profiles a person has added it to.",
    ),
});
export type DiscoverGbpLocationsInput = z.infer<typeof DiscoverGbpLocationsInputSchema>;

export interface DiscoveredGbpLocation {
  /** The bare account id this location belongs to — what a `gbp` capture leg's `account` field takes. */
  account: string;
  /** The bare location id — what a `gbp` capture leg's `location` field takes. */
  location: string;
  /** The listing's display title, or the id when the API returned none. */
  title: string;
  placeId?: string;
  address?: string;
  mapsUri?: string;
}

export interface DiscoverGbpLocationsResult {
  /** The account that was asked for, or the first one discovered. Kept for callers that predate multi-account discovery; per-location `account` is the authoritative one. */
  account: string;
  /** Every account enumerated, bare ids. One entry when `account` was supplied. */
  accounts: string[];
  locations: DiscoveredGbpLocation[];
  /** Which credential served this read — for the trace, so "it worked on prep" says with what. */
  credentialSource: "env" | "adc";
}

export interface CreateDiscoverGbpLocationsOptions {
  /** Defaults to `process.env` — injectable for the same reason `reputation.capture`'s is. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to the global `fetch` — tests supply canned responses. */
  fetchImpl?: ReputationFetchImpl;
  /** Mints a `business.manage` token from the deployment's own identity when `GOOGLE_BUSINESS_TOKEN` is unset — see gbp-credential.ts. */
  gbpAccessToken?: GbpAccessTokenProvider;
}

function bare(name: string | undefined, prefix: string): string | undefined {
  if (!name) return undefined;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function toDiscovered(account: string, location: GbpLocation): DiscoveredGbpLocation | undefined {
  const id = bare(location.name, "locations/");
  if (!id) return undefined;
  const address = location.storefrontAddress
    ? [...(location.storefrontAddress.addressLines ?? []), location.storefrontAddress.locality, location.storefrontAddress.postalCode]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join(", ")
    : undefined;
  return {
    account,
    location: id,
    title: location.title ?? id,
    ...(location.metadata?.placeId ? { placeId: location.metadata.placeId } : {}),
    ...(address ? { address } : {}),
    ...(location.metadata?.mapsUri ? { mapsUri: location.metadata.mapsUri } : {}),
  };
}

const AccountsListResponseSchema = z.object({
  accounts: z.array(z.object({ name: z.string().optional(), accountName: z.string().optional(), type: z.string().optional() })).optional(),
  nextPageToken: z.string().optional(),
});

/**
 * `mybusinessaccountmanagement.accounts.list` — the accounts this credential
 * can see. A direct, read-only GET rather than a karos-connectors call because
 * that package's allowlist mirrors the SEO/GEO connector config verbatim and
 * names no account-management method; the same reason `capture/gbp.ts` reads
 * v4 reviews itself. A failure is a reason, never a throw.
 */
async function listAccounts(token: string, fetchImpl: ReputationFetchImpl): Promise<{ ok: true; accounts: string[] } | { ok: false; reason: string }> {
  const accounts: string[] = [];
  let pageToken: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(`${ACCOUNT_MANAGEMENT_BASE}/accounts`);
      url.searchParams.set("pageSize", "20");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await fetchWithDeadline(fetchImpl, url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) return { ok: false, reason: `the GBP Account Management API returned HTTP ${response.status} listing the credential's accounts` };
      const parsed = AccountsListResponseSchema.safeParse(await response.json());
      if (!parsed.success) return { ok: false, reason: `the GBP Account Management API response did not match the expected accounts.list shape: ${parsed.error.message}` };
      for (const account of parsed.data.accounts ?? []) {
        const id = bare(account.name, "accounts/");
        if (id) accounts.push(id);
      }
      pageToken = parsed.data.nextPageToken;
      if (!pageToken) break;
    }
  } catch (err) {
    return { ok: false, reason: describeFetchFailure(err, "the GBP Account Management API") };
  }
  return { ok: true, accounts };
}

/**
 * `reputation.discoverGbpLocations` — the one listing lookup setup can do for
 * itself: the locations under the Google Business Profile account(s) the
 * client owns.
 *
 * Reads through `@agent-engine/tool-karos-connectors`'s allow-listed
 * `accounts.locations.list` rather than a bare fetch, so the same read
 * allowlist, retry policy and deadline that govern every other GBP read govern
 * this one. Authenticates the way `reputation.capture`'s own `gbp` leg does
 * (`GOOGLE_BUSINESS_TOKEN`, else the deployment's ADC in the business.manage
 * scope — see gbp-credential.ts), so a deployment that can capture reviews can
 * also list the listings they belong to, and one that cannot reports the same
 * gap in the same words.
 *
 * It does NOT search Google for a business by name. A listing found by
 * name-matching is a guess, and a wrong one means drafting replies to another
 * business's customers (`setup/SKILL.md`: "the roster is the work"). Given an
 * account id, only that account is enumerated; given none, the accounts the
 * credential MANAGES are — which for a service account is exactly the set of
 * profiles a person added it to, i.e. still ownership, not a search.
 */
export function createDiscoverGbpLocations(options: CreateDiscoverGbpLocationsOptions = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;

  return defineTool<DiscoverGbpLocationsInput, DiscoverGbpLocationsResult>({
    name: "reputation.discoverGbpLocations",
    description:
      "Lists the locations under the Google Business Profile account(s) the client owns, as candidate `gbp` capture legs. Read-only. With an `account` id only that account is read; without one, every account the deployment's Google credential manages is. Needs GOOGLE_BUSINESS_TOKEN or Application Default Credentials in the business.manage scope, and reports not_available without either.",
    version: TOOL_VERSION,
    inputSchema: DiscoverGbpLocationsInputSchema,
    async execute({ account }) {
      const credential = await resolveGbpCredential(env, options.gbpAccessToken);
      if (!credential.ok) {
        return notAvailable<DiscoverGbpLocationsResult>(`${credential.reason} — the Google Business Profile listings cannot be enumerated (or captured) until a credential lands`);
      }
      const token = credential.token;

      let accounts: string[];
      if (account !== undefined) {
        accounts = [bare(account, "accounts/") ?? account];
      } else {
        const listed = await listAccounts(token, fetchImpl);
        if (!listed.ok) return notAvailable<DiscoverGbpLocationsResult>(listed.reason);
        if (listed.accounts.length === 0) {
          return notAvailable<DiscoverGbpLocationsResult>(
            `the Google credential this engine runs with (${credential.source === "adc" ? "its own service account" : "GOOGLE_BUSINESS_TOKEN"}) manages no Google Business Profile account — add it as a manager of the client's Business Profile (Business Profile Manager → Users), or set gbpAccountId in client config`,
          );
        }
        accounts = listed.accounts;
      }

      const locations: DiscoveredGbpLocation[] = [];
      for (const accountId of accounts) {
        let pageToken: string | undefined;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const outcome = await accountsLocationsList(
            { accessToken: token },
            { accountId, ...(pageToken !== undefined ? { pageToken } : {}) },
            { fetchImpl },
          );
          if (outcome.status !== "ok" || !outcome.payload) {
            return notAvailable<DiscoverGbpLocationsResult>(
              `Google Business Profile account "${accountId}": ${outcome.status}${outcome.reason ? ` — ${outcome.reason}` : ""}`,
            );
          }
          for (const location of outcome.payload.locations ?? []) {
            const discovered = toDiscovered(accountId, location);
            if (discovered) locations.push(discovered);
          }
          pageToken = outcome.payload.nextPageToken;
          if (!pageToken) break;
        }
      }

      return success<DiscoverGbpLocationsResult>({ account: accounts[0]!, accounts, locations, credentialSource: credential.source });
    },
  });
}
