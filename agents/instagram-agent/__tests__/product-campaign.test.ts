import { describe, expect, it } from "vitest";
import {
  buildCampaignCopy,
  buildCampaignSelections,
  buildCampaignSlidesData,
  CAMPAIGN_MAX_SCENES,
  CAMPAIGN_MIN_SCENES,
  CAMPAIGN_PLATE_FILE,
  campaignCaptionDirection,
  campaignPlateHtml,
  campaignProductName,
  campaignSceneCount,
  checkInImageText,
  fallbackCampaignCaption,
  inImageCopyFor,
  judgeCampaignFrame,
  pickProductPhoto,
  planCampaignScenes,
  productNameFromDescription,
  productPhotoCandidates,
  redrawPrompt,
  visionReadingOf,
  type CampaignFrame,
  type VisionReading,
} from "../src/workflow/product-campaign.js";
import { InstagramCopyOutputSchema, ImageSelectionSchema } from "../src/workflow/types.js";

/**
 * Stage 4 of the owner's reference-looks plan, approved 2026-09-24: a
 * picture-only campaign carousel of scenes built from the client's REAL
 * product. These are the pure decisions; `product-campaign-workflow.test.ts`
 * drives a whole run.
 */

const SITE = (caption: string, extra = "") =>
  `[client library, filed 2026-09-24] A glass perfume bottle on a white background${extra}. Published on the client's own website on the page "Signature Lace | Hanky Panky", where the client captions it "${caption}". The client publishes this image on its own website, so it is the client's own imagery. [licence: client-site]`;

describe("the scene plan", () => {
  it("sizes the campaign to the run's generation allowance: two kept for redraws, never above six or below three", () => {
    expect(campaignSceneCount(8)).toBe(6);
    expect(campaignSceneCount(7)).toBe(5);
    expect(campaignSceneCount(6)).toBe(4);
    expect(campaignSceneCount(5)).toBe(CAMPAIGN_MIN_SCENES);
    expect(campaignSceneCount(3)).toBe(CAMPAIGN_MIN_SCENES);
    expect(campaignSceneCount(0)).toBe(CAMPAIGN_MIN_SCENES);
    expect(campaignSceneCount(40)).toBe(CAMPAIGN_MAX_SCENES);
    expect(campaignSceneCount(Number.NaN)).toBe(CAMPAIGN_MIN_SCENES);
  });

  it("shows the reference campaign's six scenes in its order, the billboard lettered with the slogan and the poster with the product name", () => {
    const scenes = planCampaignScenes({ count: 6, productName: "Signature Lace", slogan: "Made to be seen.", companyName: "Hanky Panky", audience: "women who buy lingerie for themselves" });
    expect(scenes.map((s) => s.id)).toEqual(["hero", "detail", "billboard", "lifestyle", "street-poster", "flat-lay"]);
    expect(scenes.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(scenes.find((s) => s.id === "billboard")?.lettering).toBe("Made to be seen");
    expect(scenes.find((s) => s.id === "street-poster")?.lettering).toBe("Signature Lace");
    // Only those two carry words; every other scene carries the product's own label and nothing else.
    expect(scenes.filter((s) => s.lettering !== undefined).map((s) => s.id)).toEqual(["billboard", "street-poster"]);
    // Every scene is built on the reference, and names the product.
    for (const scene of scenes) expect(scene.prompt).toContain("Signature Lace (the reference image)");
    expect(scenes.find((s) => s.id === "hero")?.fidelity).toBe("label");
    expect(scenes.find((s) => s.id === "lifestyle")?.prompt).toContain("women who buy lingerie for themselves");
  });

  it("a smaller budget keeps the most important scenes, still in display order", () => {
    expect(planCampaignScenes({ count: 3, productName: "X" }).map((s) => s.id)).toEqual(["hero", "billboard", "lifestyle"]);
    expect(planCampaignScenes({ count: 4, productName: "X" }).map((s) => s.id)).toEqual(["hero", "detail", "billboard", "lifestyle"]);
  });

  it("letters the product name when there is no slogan, and letters nothing it cannot letter reliably", () => {
    const noSlogan = planCampaignScenes({ count: 6, productName: "Rally" });
    expect(noSlogan.find((s) => s.id === "billboard")?.lettering).toBe("Rally");
    // A Hebrew slogan and a Hebrew product name: image models letter other
    // scripts unreliably, so the billboard and poster carry no words at all.
    const hebrew = planCampaignScenes({ count: 6, productName: "תחרה", slogan: "נוצר כדי להיראות", companyName: "האנקי" });
    expect(hebrew.every((s) => s.lettering === undefined)).toBe(true);
    expect(hebrew.find((s) => s.id === "billboard")?.prompt).toContain("clean brand-coloured ground");
  });

  it("the in-image line is the client's own words, short, Latin, without its trailing punctuation", () => {
    expect(inImageCopyFor("Made to be seen.")).toBe("Made to be seen");
    expect(inImageCopyFor("“Drink the rally!”")).toBe("Drink the rally");
    expect(inImageCopyFor("  Signature   Lace ")).toBe("Signature Lace");
    expect(inImageCopyFor("One two three four five six seven")).toBeUndefined();
    expect(inImageCopyFor("A".repeat(41))).toBeUndefined();
    expect(inImageCopyFor("נוצר כדי להיראות")).toBeUndefined();
    expect(inImageCopyFor("Shop | Hanky Panky")).toBeUndefined();
    expect(inImageCopyFor("9")).toBeUndefined();
    expect(inImageCopyFor(undefined)).toBeUndefined();
  });

  it("a redraw names what the last frame got wrong", () => {
    const [hero] = planCampaignScenes({ count: 3, productName: "Rally" });
    expect(redrawPrompt(hero!, 'the lettering reads "Rallly", not "Rally" letter for letter.')).toContain('The previous attempt was refused because the lettering reads "Rallly"');
  });
});

describe("the product photo", () => {
  it("offers this run's uploads first, then only the client's OWN library frames, product-looking ones first", () => {
    const candidates = productPhotoCandidates(
      [{ path: ".media-cache/r/n1-client.png", description: "[client upload, slot 1] a bottle", label: "Rally bottle" }],
      [
        { path: ".media-cache/r/n2-lib.png", description: "[client library, filed 2026-09-01] The team at the office. The client owns this image and supplied it deliberately for an earlier post." },
        { path: ".media-cache/r/n3-lib.png", description: SITE("Signature Lace Eau de Parfum") },
        { path: ".media-cache/r/n4-lib.png", description: "[client library, filed 2026-09-01] A product bottle. Filed in this client's media library from unsplash. [licence: Unsplash]" },
      ],
    );
    expect(candidates.map((c) => c.path)).toEqual([".media-cache/r/n1-client.png", ".media-cache/r/n3-lib.png", ".media-cache/r/n2-lib.png"]);
    expect(candidates.map((c) => c.origin)).toEqual(["client-upload", "client-site", "client-library"]);
    // A third-party frame is never a reference: it is neither the client's product nor the client's rights.
    expect(candidates.some((c) => c.path.includes("n4"))).toBe(false);
    expect(candidates[0]!.productName).toBe("Rally bottle");
    expect(candidates[1]!.productName).toBe("Signature Lace Eau de Parfum");
  });

  it("reads the product's name off the site's caption, else the page title's first segment", () => {
    expect(productNameFromDescription(SITE("Signature Lace Original Rise Thong"))).toBe("Signature Lace Original Rise Thong");
    expect(productNameFromDescription('Published on the client\'s own website on the page "Original Rise Thong | Hanky Panky".')).toBe("Original Rise Thong");
    expect(productNameFromDescription("A bottle.")).toBeUndefined();
  });

  it("a vision model reads, code decides: an upload needs 3, a library frame 4, and a watermark or screenshot never qualifies", () => {
    const candidates = productPhotoCandidates(
      [{ path: "u.png", description: "[client upload, slot 1] a bottle" }],
      [
        { path: "a.png", description: SITE("A") },
        { path: "b.png", description: SITE("B") },
      ],
    );
    const read = (entries: Array<[string, Partial<VisionReading>]>): Map<string, VisionReading> =>
      new Map(entries.map(([p, r]): [string, VisionReading] => [p, { ...r, textInImage: r.textInImage ?? [] }]));
    // Upload at 3 wins over nothing; a library frame at 3 does not qualify.
    expect(pickProductPhoto(candidates, read([["u.png", { fitScore: 3 }], ["a.png", { fitScore: 3 }]])).chosen?.candidate.path).toBe("u.png");
    expect(pickProductPhoto(candidates, read([["a.png", { fitScore: 3 }]])).chosen).toBeUndefined();
    // Highest fit wins; a tie goes to the earlier candidate.
    expect(pickProductPhoto(candidates, read([["u.png", { fitScore: 3 }], ["a.png", { fitScore: 5 }]])).chosen?.candidate.path).toBe("a.png");
    expect(pickProductPhoto(candidates, read([["a.png", { fitScore: 5 }], ["b.png", { fitScore: 5 }]])).chosen?.candidate.path).toBe("a.png");
    const refused = pickProductPhoto(candidates, read([["a.png", { fitScore: 5, hasWatermark: true }], ["b.png", { fitScore: 5, looksLikeScreenshot: true }]]));
    expect(refused.chosen).toBeUndefined();
    expect(refused.considered.map((c) => c.verdict)).toEqual(["not read by the vision pass", "refused: unusable, watermarked or a screenshot", "refused: unusable, watermarked or a screenshot"]);
  });

  it("names the product from the override, then the photo, then the brief — never invents one", () => {
    expect(campaignProductName({ override: " Rally ", fromPhoto: "Bottle" })).toBe("Rally");
    expect(campaignProductName({ fromPhoto: "Signature Lace" , offers: [{ name: "Offer" }] })).toBe("Signature Lace");
    expect(campaignProductName({ offers: [{ name: "The Starter Kit" }] })).toBe("The Starter Kit");
    expect(campaignProductName({ ownAssets: [{ title: "Case study", kind: "case_study" }, { title: "The Widget", kind: "product" }] })).toBe("The Widget");
    expect(campaignProductName({})).toBeUndefined();
  });

  it("normalises a vision row defensively", () => {
    expect(visionReadingOf({ ref: "x", textInImage: ["A", 3, "B"], fitScore: "5", quality: "usable" })).toEqual({ textInImage: ["A", "B"], quality: "usable" });
  });
});

describe("the in-image text, letter by letter", () => {
  it("passes the exact words, whatever their case, spacing or line breaks", () => {
    expect(checkInImageText("Made to be seen", ["MADE TO BE SEEN"]).ok).toBe(true);
    expect(checkInImageText("Made to be seen", ["Made to", "be  seen"]).ok).toBe(true);
    expect(checkInImageText("Made to be seen", ["SIGNATURE LACE", "Made to be seen."]).ok).toBe(true);
    // A typographic apostrophe is the same character to a reader.
    expect(checkInImageText("Don't wait", ["DON’T WAIT"]).ok).toBe(true);
  });

  it("fails one wrong, missing or extra letter, and an empty read", () => {
    expect(checkInImageText("Made to be seen", ["Made to be sean"]).ok).toBe(false);
    expect(checkInImageText("Made to be seen", ["Made to be sen"]).ok).toBe(false);
    expect(checkInImageText("Made to be seen", ["Made to be seeen"]).ok).toBe(false);
    expect(checkInImageText("Signature Lace", ["Signature Laces"]).ok).toBe(false);
    expect(checkInImageText("Signature Lace", ["XSignature Lace"]).ok).toBe(false);
    expect(checkInImageText("Signature Lace", ["Signature", "Lcae"]).ok).toBe(false);
    const empty = checkInImageText("Signature Lace", []);
    expect(empty.ok).toBe(false);
    expect(empty.reason).toContain("no legible words");
    expect(checkInImageText("Made to be seen", ["Made to be sean"]).reason).toBe('the lettering reads "Made to be sean", not "Made to be seen" letter for letter');
  });
});

describe("may a generated frame ship?", () => {
  const LABEL = ["SIGNATURE LACE", "Eau de Parfum", "50 ml"];
  const billboard = { lettering: "Made to be seen", fidelity: "presence" as const };
  const hero = { fidelity: "label" as const };
  const reading = (r: Partial<VisionReading>): VisionReading => ({ textInImage: [], fitScore: 4, quality: "usable", ...r });

  it("ships a frame that carries its line exactly, the product's label, and nothing else", () => {
    const verdict = judgeCampaignFrame(billboard, LABEL, reading({ textInImage: ["SIGNATURE LACE", "Made to be seen"] }));
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.lettering?.ok).toBe(true);
  });

  it("never ships a misspelled line — even beside a correct copy of it", () => {
    expect(judgeCampaignFrame(billboard, LABEL, reading({ textInImage: ["Made to be sen"] })).ok).toBe(false);
    const twice = judgeCampaignFrame(billboard, LABEL, reading({ textInImage: ["Made to be seen", "Made to be sene"] }));
    expect(twice.ok).toBe(false);
    expect(twice.reasons.join(" ")).toContain("sene");
  });

  it("refuses a re-lettered label and any stray words on a scene that should carry none", () => {
    const relettered = judgeCampaignFrame(hero, LABEL, reading({ textInImage: ["SIGNATURE LACCE", "Eau de Parfum"] }));
    expect(relettered.ok).toBe(false);
    expect(relettered.fidelity?.invented).toEqual(["lacce"]);
    expect(judgeCampaignFrame({ fidelity: "presence" }, LABEL, reading({ textInImage: ["SALE"] })).ok).toBe(false);
  });

  it("holds the hero to its label, and forgives small print a wide scene cannot resolve", () => {
    const lost = judgeCampaignFrame(hero, LABEL, reading({ textInImage: [] }));
    expect(lost.ok).toBe(false);
    expect(lost.reasons.join(" ")).toContain("label did not survive");
    expect(judgeCampaignFrame({ fidelity: "presence" }, LABEL, reading({ textInImage: [] })).ok).toBe(true);
  });

  it("refuses a frame whose product is not recognisably the client's, an unread frame, and a watermarked one", () => {
    expect(judgeCampaignFrame(hero, [], reading({ fitScore: 2 })).ok).toBe(false);
    expect(judgeCampaignFrame(hero, [], reading({ fitScore: undefined as unknown as number })).ok).toBe(false);
    expect(judgeCampaignFrame(hero, [], undefined).reasons[0]).toContain("unverified");
    expect(judgeCampaignFrame(hero, [], reading({ hasWatermark: true })).ok).toBe(false);
  });
});

describe("the deliverable", () => {
  const scenes = planCampaignScenes({ count: 3, productName: "Rally", slogan: "Drink the rally" });
  const frames: CampaignFrame[] = scenes.map((scene) => ({ scene, path: `.media-cache/r/n${scene.n}-gen0.png`, fitScore: 5, round: 1 }));

  it("every slide is the full-bleed campaign plate over its scene, with the lettering carried for the guardrail and the reviewer", () => {
    const data = buildCampaignSlidesData({ clientSlug: "acme", postId: "p1", repoRoot: "/repo", runId: "r", canvas: { w: 1080, h: 1440, scale: 2, slides_min: 6, slides_max: 8 }, frames });
    expect(data.templateDir).toBe(".template-cache/r/product-campaign");
    expect(data.outDir).toBe("instagram-output/acme/p1");
    expect(data.slides.map((s) => s.template)).toEqual([CAMPAIGN_PLATE_FILE, CAMPAIGN_PLATE_FILE, CAMPAIGN_PLATE_FILE]);
    expect(data.slides.map((s) => s.images["hero"])).toEqual(frames.map((f) => f.path));
    expect(data.slides[1]!.fields).toEqual({ sceneLabel: "billboard", lettering: "Drink the rally" });
  });

  it("the plate is the picture and nothing else, and raises the renderer's ready flag", () => {
    const html = campaignPlateHtml();
    expect(html).toContain('src="{{image:hero}}"');
    expect(html).toContain("object-fit: cover");
    expect(html).toContain("__CAROUSEL_READY__");
    // No text slot: nothing but the image is substituted into this plate.
    expect(html.match(/\{\{[^}]+\}\}/g)).toEqual(["{{image:hero}}"]);
  });

  it("selections are rights-clear generated frames built on the client's own product photo", () => {
    const selections = buildCampaignSelections(frames, "client-site");
    for (const s of selections) expect(ImageSelectionSchema.safeParse(s).success).toBe(true);
    expect(selections.every((s) => s.rightsUsable && s.watermarkFree && s.licenceClass === "blanket")).toBe(true);
    expect(selections[0]!.license).toContain("Generated image");
    expect(selections[0]!.license).toContain("from the client's own website");
    expect(selections[1]!.reason).toContain('lettering read back letter for letter ("Drink the rally")');
  });

  it("the copy is one photo slide per scene under the writer's caption, and parses as the run's copy", () => {
    const copy = buildCampaignCopy({ frames, caption: "Meet Rally.", productName: "Rally", sourceRef: "a fact", hookPattern: "relatable_pov" });
    expect(InstagramCopyOutputSchema.safeParse(copy).success).toBe(true);
    expect(copy.slides.map((s) => s.headline)).toEqual(["Rally: hero shot", "Rally: billboard", "Rally: in use"]);
    expect(copy.slides.every((s) => s.layout === "photo")).toBe(true);
    expect(copy.caption).toBe("Meet Rally.");
  });

  it("the writer is told the post is a campaign on its existing runDirection field, and a caption always exists", () => {
    const direction = campaignCaptionDirection({ productName: "Rally", sceneLabels: ["hero shot", "billboard"], personDirection: "Launch week" });
    expect(direction.startsWith("Launch week")).toBe(true);
    expect(direction).toContain("PRODUCT CAMPAIGN");
    expect(direction).toContain("never invent a claim");
    expect(fallbackCampaignCaption({ productName: "Rally", slogan: "rally", oneLiner: "Electrolytes for runners." })).toBe("Rally\n\nElectrolytes for runners.");
  });
});
