import { describe, expect, it } from "vitest";
import { createCaptureSite } from "../src/capture/capture-site-tool.js";
import { testCtx } from "./fixtures.js";

const OLD_SITE = `<!doctype html><html lang="en"><head><title>Karos · Your AI CMO</title>
<meta name="description" content="The AI-powered marketing team."></head><body>
<header><nav><a href="/agents">Agents</a><a href="/blog">Blog</a><a class="btn" href="https://cal.com/karos">Book a call</a></nav></header>
<main>
<h1>The AI CMO that moves 1st.</h1>
<p>The AI-powered marketing team that runs your strategy, content, and growth end to end.</p>
<img src="/art/kairos-salviati.jpg" alt="Kairos, Time of Decision. Fresco by Francesco Salviati.">
<h2>how it works</h2>
<li>Point it at your brand. Give Karos your site. It reads your brand, your voice, and your market in minutes.</li>
<button>Get started</button>
</main></body></html>`;

describe("landing.captureSite (fetch fallback)", () => {
  const noBrowser = async () => null;

  it("extracts title, description, headings, nav links, CTAs, text blocks and absolute image URLs from raw HTML", async () => {
    const fetchImpl: typeof fetch = async () => new Response(OLD_SITE, { status: 200, headers: { "content-type": "text/html" } });
    const tool = createCaptureSite({ fetchImpl, loadChromium: noBrowser });
    const outcome = await tool.execute({ url: "https://karoslabs.com/", runId: "r", clientSlug: "karoslabs", timeoutMs: 5000 }, { ctx: testCtx() });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    const c = outcome.result;
    expect(c.method).toBe("fetch");
    expect(c.title).toBe("Karos · Your AI CMO");
    expect(c.description).toBe("The AI-powered marketing team.");
    expect(c.lang).toBe("en");
    expect(c.headings).toEqual([{ level: 1, text: "The AI CMO that moves 1st." }, { level: 2, text: "how it works" }]);
    expect(c.navLinks.map((l) => l.text)).toEqual(["Agents", "Blog", "Book a call"]);
    expect(c.ctas).toEqual(expect.arrayContaining(["Book a call", "Get started"]));
    expect(c.images).toEqual([{ src: "https://karoslabs.com/art/kairos-salviati.jpg", alt: "Kairos, Time of Decision. Fresco by Francesco Salviati." }]);
    expect(c.textBlocks.length).toBe(2);
    expect(c.wordCount).toBeGreaterThan(20);
    expect(c.screenshots).toEqual([]);
  });

  it("reports an HTTP error page as content_fail and a network failure as tooling_error", async () => {
    const tool500 = createCaptureSite({ fetchImpl: async () => new Response("nope", { status: 503 }), loadChromium: noBrowser });
    const fail = await tool500.execute({ url: "https://down.example/", runId: "r", clientSlug: "c", timeoutMs: 5000 }, { ctx: testCtx() });
    expect(fail.status).toBe("content_fail");

    const toolNet = createCaptureSite({
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
      loadChromium: noBrowser,
    });
    const err = await toolNet.execute({ url: "https://gone.example/", runId: "r", clientSlug: "c", timeoutMs: 5000 }, { ctx: testCtx() });
    expect(err.status).toBe("tooling_error");
  });
});
