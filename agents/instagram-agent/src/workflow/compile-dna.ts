import type { ClientClassification } from "@agent-engine/workflow";
import type { EditorialSeriesId } from "./editorial-series.js";
import type { PictureDensity } from "./imagery-floor.js";

/**
 * compileDNA v0 (2026-09-25): the three decisions that used to be read off
 * free-text industry with a regex, read instead off the client's
 * classification (`resolveClientClassification`). The research's build order
 * (§4.4 item 6) starts with exactly these three: series affinity, imagery,
 * peers. Pure, no model call. A client with no classification keeps the
 * legacy regex path, so nothing regresses while a record is missing.
 *
 * Values from `docs/research/2026-09-24-instagram-owner-feedback/`
 * (09-architecture-conclusions.md §4.1, guidelines/ig-kit-*.md).
 */

/** The archetype card's `series_affinity`: a +1 nudge in the client's library, never the choice itself. */
export const ARCHETYPE_SERIES_AFFINITY: Readonly<Record<ClientClassification["archetype"], readonly EditorialSeriesId[]>> = {
  brand: ["head_to_head", "by_the_numbers"],
  place: ["field_notes", "the_list"],
  person: ["in_their_words", "field_notes"],
  publisher: ["the_breakdown", "by_the_numbers"],
  platform: ["head_to_head", "the_playbook"],
  business: ["in_their_words", "the_breakdown"],
  institution: ["field_notes", "in_their_words"],
};

/**
 * Per category pack: whether its convention is photo-first (the kit's
 * `photoShareMin` at 0.6 or above), and its peer accounts, the subject peers
 * the harvest reads when the client names no reference account. Peer lists
 * are the handles each kit names; @mixmagmagazine is @mixmag now (#253 §3.0).
 */
export const CATEGORY_PACKS: Readonly<Record<string, { photoFirst: boolean; peers: readonly string[] }>> = {
  "marketing-advertising": { photoFirst: false, peers: ["nogood.io", "orenmeetsworld", "sintra.ai", "peoplebrandsandthings", "thebrandblueprint_", "reputeforge"] },
  "tech-business-news": { photoFirst: false, peers: ["calcalist", "themarker_online", "globesnews", "ynetgram", "wired", "morningbrew"] },
  "startups-venture": { photoFirst: true, peers: ["a16z", "join_ef", "founderspodcast", "sahilbloom", "ycombinator"] },
  "fashion-intimates": { photoFirst: true, peers: ["aerie", "meundies", "thirdlove", "savagexfenty", "skims", "knix", "parade", "harperwilde"] },
  "travel-local-discovery": { photoFirst: true, peers: ["mindtrip.ai", "mapstr", "infatuation", "beli_eats", "secret_nyc"] },
  "personal-finance-investing": { photoFirst: false, peers: ["invistainco", "infomoney", "gustavocerbasi", "nubank", "btgpactual", "c6bank"] },
  "music-nightlife": { photoFirst: true, peers: ["boilerroomtv", "defected", "mixmag", "ra_news", "cercle", "6am_group"] },
  "luxury-hospitality-real-estate": { photoFirst: true, peers: ["archdigest", "kinfolk", "gstaadpalace", "oetkerhotels", "chevalblancofficial", "aman"] },
};

export interface InstagramDna {
  seriesAffinity: readonly EditorialSeriesId[];
  /**
   * `photo-first` when the pack's convention is photo-led. Never `standard`:
   * a pack that is not photo-led says nothing, so the rungs after it (the
   * exemplar library, RFC-26 Phase 4a) still decide, exactly as before.
   */
  imagery?: PictureDensity;
  /** Empty for a category with no pack: the legacy benchmark table applies. */
  peers: readonly string[];
  /** One line for the gate payload and the trace. */
  basis: string;
}

export function compileInstagramDna(classification: ClientClassification): InstagramDna {
  const pack = CATEGORY_PACKS[classification.category];
  return {
    seriesAffinity: ARCHETYPE_SERIES_AFFINITY[classification.archetype],
    ...(pack?.photoFirst === true ? { imagery: "photo-first" as const } : {}),
    peers: pack?.peers ?? [],
    basis: `${classification.archetype} · ${classification.category} · ${classification.involvement} · ${classification.audience} · ${classification.locale} (${classification.source})`,
  };
}
