import { asString, fetchJson, type ImageSearchHit, type ImageSearchProvider } from "../providers.js";

const FIND_PLACE = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json";
const PLACE_PHOTO = "https://maps.googleapis.com/maps/api/place/photo";

interface PlacesCandidate {
  place_id?: unknown;
  photos?: unknown;
}

interface PlacePhoto {
  photo_reference?: unknown;
  html_attributions?: unknown;
}

/**
 * Google Places — geo-verified venue photography.
 *
 * The value here is not breadth, it is *verification*: a photo attached to a
 * place_id is a photo of that place, established by construction rather than
 * inferred from a caption. For a `named_venue` slide that is the difference
 * between the right building and a stock lobby.
 *
 * Rated `blanket`: photos served through the Places Photo endpoint are
 * licensed for use in the context of displaying Google Places data, and
 * Google supplies `html_attributions` which is carried into the credit. That
 * is a real, citable basis — though note the attribution requirement is
 * stricter than Unsplash's, which is why it is not the top of the mood chain.
 *
 * ## The URL that gets downloaded embeds the API key
 *
 * The Places Photo endpoint has no key-free variant: the image URL itself
 * must carry `key=`. That URL is handed to the downloader and never persisted
 * — only the resulting file path reaches the run record — but it does mean a
 * verbose HTTP log on the download path would capture it. Worth knowing
 * before turning request logging up on this package.
 */
export function createGooglePlacesProvider(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Long edge requested from the photo endpoint. */
  maxWidth?: number;
}): ImageSearchProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxWidth = options.maxWidth ?? 1600;

  return {
    name: "google_places",
    async search(query: string, limit: number): Promise<ImageSearchHit[]> {
      const findUrl = new URL(FIND_PLACE);
      findUrl.searchParams.set("input", query);
      findUrl.searchParams.set("inputtype", "textquery");
      findUrl.searchParams.set("fields", "place_id,photos,name");
      findUrl.searchParams.set("key", options.apiKey);

      let body: { candidates?: unknown };
      try {
        body = (await fetchJson(fetchImpl, findUrl, { provider: "google_places", query, timeoutMs })) as {
          candidates?: unknown;
        };
      } catch {
        // Demote rather than fail the run: a venue lookup that misses is the
        // normal case for a mood slide, and the chain has keyless sources
        // behind this one.
        return [];
      }

      const candidates = Array.isArray(body.candidates) ? body.candidates : [];
      // Only the top candidate. The second-best match for a place name is
      // usually a different place, and a wrong-but-confident venue photo is
      // worse than none — the legacy connector took the same single-candidate
      // stance for the same reason.
      const best = candidates[0] as PlacesCandidate | undefined;
      if (best === undefined) return [];

      const photos = Array.isArray(best.photos) ? best.photos : [];
      const placeId = asString(best.place_id);
      const hits: ImageSearchHit[] = [];

      for (const raw of photos.slice(0, limit)) {
        const photo = raw as PlacePhoto;
        const reference = asString(photo.photo_reference);
        if (!reference) continue;

        const photoUrl = new URL(PLACE_PHOTO);
        photoUrl.searchParams.set("maxwidth", String(maxWidth));
        photoUrl.searchParams.set("photo_reference", reference);
        photoUrl.searchParams.set("key", options.apiKey);

        const attributions = Array.isArray(photo.html_attributions)
          ? photo.html_attributions.map((a) => asString(a)).filter((a): a is string => a !== undefined)
          : [];
        // Attributions arrive as HTML anchors; the vetting agent reads text.
        const credit = attributions.length > 0 ? attributions.join(", ").replace(/<[^>]*>/g, "").trim() : "Google Places contributor";

        hits.push({
          // The reference is opaque and stable per photo — a good filename seed,
          // and unlike the URL it does not embed the key.
          id: reference.slice(0, 64),
          url: photoUrl.toString(),
          description: `geo-verified photo of "${query}" from Google Places (contributed by ${credit})`,
          license: `Google Places photo — usable when displaying Places data, credit "${credit}"`,
          licenseConfidence: "blanket",
          credit,
          ...(placeId ? { pageUrl: `https://www.google.com/maps/place/?q=place_id:${placeId}` } : {}),
        });
      }

      return hits;
    },
  };
}
