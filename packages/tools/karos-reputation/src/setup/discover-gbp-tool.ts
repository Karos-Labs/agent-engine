import { z } from "zod";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";
import { accountsLocationsList, type GbpLocation } from "@agent-engine/tool-karos-connectors";
import type { ReputationFetchImpl } from "../capture/types.js";

const TOOL_VERSION = "1.0.0";

/** Locations are paged; a real account has a handful, and this cap is only there so a runaway `nextPageToken` cannot loop a setup step forever. */
const MAX_PAGES = 10;

export const DiscoverGbpLocationsInputSchema = z.object({
  account: z
    .string()
    .min(1)
    .describe("The Google Business Profile account id (with or without the `accounts/` prefix) whose locations to list."),
});
export type DiscoverGbpLocationsInput = z.infer<typeof DiscoverGbpLocationsInputSchema>;

export interface DiscoveredGbpLocation {
  /** The bare location id — what a `gbp` capture leg's `location` field takes. */
  location: string;
  /** The listing's display title, or the id when the API returned none. */
  title: string;
  placeId?: string;
  address?: string;
  mapsUri?: string;
}

export interface DiscoverGbpLocationsResult {
  /** The bare account id — what a `gbp` capture leg's `account` field takes. */
  account: string;
  locations: DiscoveredGbpLocation[];
}

export interface CreateDiscoverGbpLocationsOptions {
  /** Defaults to `process.env` — injectable for the same reason `reputation.capture`'s is. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to the global `fetch` — tests supply canned responses. */
  fetchImpl?: ReputationFetchImpl;
}

function bare(name: string | undefined, prefix: string): string | undefined {
  if (!name) return undefined;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function toDiscovered(location: GbpLocation): DiscoveredGbpLocation | undefined {
  const id = bare(location.name, "locations/");
  if (!id) return undefined;
  const address = location.storefrontAddress
    ? [...(location.storefrontAddress.addressLines ?? []), location.storefrontAddress.locality, location.storefrontAddress.postalCode]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join(", ")
    : undefined;
  return {
    location: id,
    title: location.title ?? id,
    ...(location.metadata?.placeId ? { placeId: location.metadata.placeId } : {}),
    ...(address ? { address } : {}),
    ...(location.metadata?.mapsUri ? { mapsUri: location.metadata.mapsUri } : {}),
  };
}

/**
 * `reputation.discoverGbpLocations` — the one listing lookup setup can do for
 * itself: the locations under a Google Business Profile account the client
 * has already told us about.
 *
 * Reads through `@agent-engine/tool-karos-connectors`'s allow-listed
 * `accounts.locations.list` rather than a bare fetch, so the same read
 * allowlist, retry policy and deadline that govern every other GBP read govern
 * this one. Authenticates the way `reputation.capture`'s own `gbp` leg does
 * (`GOOGLE_BUSINESS_TOKEN`), so a deployment that can capture reviews can also
 * list the listings they belong to, and one that cannot reports the same gap
 * in the same words.
 *
 * It does NOT search Google for a business by name. A listing found by
 * name-matching is a guess, and a wrong one means drafting replies to another
 * business's customers (`setup/SKILL.md`: "the roster is the work"). The
 * account id is the client's assertion of ownership; this only enumerates
 * what that account holds.
 */
export function createDiscoverGbpLocations(options: CreateDiscoverGbpLocationsOptions = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;

  return defineTool<DiscoverGbpLocationsInput, DiscoverGbpLocationsResult>({
    name: "reputation.discoverGbpLocations",
    description:
      "Lists the locations under a Google Business Profile account the client owns, as candidate `gbp` capture legs. Read-only; needs the same GOOGLE_BUSINESS_TOKEN the capture leg uses and reports not_available without it.",
    version: TOOL_VERSION,
    inputSchema: DiscoverGbpLocationsInputSchema,
    async execute({ account }) {
      const token = env["GOOGLE_BUSINESS_TOKEN"];
      if (!token) {
        return notAvailable<DiscoverGbpLocationsResult>(
          "missing env GOOGLE_BUSINESS_TOKEN — the Google Business Profile listings cannot be enumerated (or captured) until the credential lands",
        );
      }

      const accountId = bare(account, "accounts/") ?? account;
      const locations: DiscoveredGbpLocation[] = [];
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
          const discovered = toDiscovered(location);
          if (discovered) locations.push(discovered);
        }
        pageToken = outcome.payload.nextPageToken;
        if (!pageToken) break;
      }

      return success<DiscoverGbpLocationsResult>({ account: accountId, locations });
    },
  });
}
