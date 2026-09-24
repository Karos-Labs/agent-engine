import { describe, expect, it } from "vitest";
import { classifySitePage, keepClientSitePages } from "../src/workflow/site-identity.js";
import { buildBriefAgentInput } from "../src/workflow/client-brief.js";

/** Owner feedback round 2026-09-24 (WS-03): Kindly Yours' brief was written from a for-sale lander. */

const verdict = (title: string, text: string) => classifySitePage({ url: "https://x.example", title, text }).verdict;

describe("is this page really the client's site", () => {
  it("recognises a parked, for-sale domain", () => {
    expect(verdict("kindlyyours.com", "kindlyyours.com is for sale! Get this domain. Make an offer today. Powered by GoDaddy.")).toBe("parked");
    expect(verdict("Buy this domain", "The owner of this domain has parked it with Afternic.")).toBe("parked");
  });

  it("recognises a closed store and a bot challenge", () => {
    expect(verdict("Store unavailable", "This store is unavailable. Are you the store owner? Log in here")).toBe("unavailable");
    expect(verdict("Just a moment...", "Checking if the site connection is secure")).toBe("challenge");
  });

  it("does not refuse a real site that mentions a registrar or sells with offers", () => {
    expect(verdict("Thisiskindly | Size-inclusive intimates", "Lingerie made for every body. Shop bras and briefs. Website powered by GoDaddy Website Builder.")).toBe("ok");
    expect(verdict("Vintage Watches", "Every piece is inspected. Make an offer on any watch over $500 and we reply within a day.")).toBe("ok");
    expect(verdict("Our story", "It took just a moment to decide: we would build lingerie that fits.")).toBe("ok");
  });

  it("keeps the real pages and names each dropped one", () => {
    const { kept, gaps } = keepClientSitePages([
      { url: "https://kindlyyours.com", title: "kindlyyours.com", text: "kindlyyours.com is for sale. Make an offer on this domain." },
      { url: "https://thisiskindly.com", title: "Kindly", text: "Size-inclusive intimates." },
    ]);
    expect(kept.map((p) => p.url)).toEqual(["https://thisiskindly.com"]);
    expect(gaps[0]).toContain("kindlyyours.com was not used as the client's site");
  });

  it("never lets a lander ground the brief", () => {
    const build = buildBriefAgentInput({
      contextDocs: {},
      sitePages: [{ url: "https://kindlyyours.com", title: "kindlyyours.com", text: "kindlyyours.com is for sale. Buy this domain." }],
    } as never);
    expect(build.input.sitePages).toEqual([]);
    expect(build.gaps.some((g) => g.includes("reads as parked"))).toBe(true);
  });
});
