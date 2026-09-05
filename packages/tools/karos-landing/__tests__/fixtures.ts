import type { AgentContext } from "@agent-engine/core";
import type { GcsArtifactStoreLike, ArtifactUploadResult } from "@agent-engine/tool-common";
import type { PageBlueprint, PageParts } from "../src/page/types.js";

export function testCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return { runId: "run_test", clientSlug: "northwind", productId: "landing-builder-agent", runKind: "setup", metadata: {}, ...overrides };
}

/** A blueprint that reads like a real one: a light ground, one accent, five sections, a sourced figure. */
export function sampleBlueprint(overrides: Partial<PageBlueprint> = {}): PageBlueprint {
  return {
    pov: "Cream ground, near-black Space Grotesk headlines, one burnt-orange action per view; decisive, unhurried.",
    language: "en-US",
    direction: "ltr",
    palette: { ground: "#f2f1ec", ground2: "#ffffff", fg: "#1a1a1a", fg2: "#4b4b4b", accent: "#ff6b2c", edge: "#dcd9d2" },
    typography: { display: "Space Grotesk", body: "Inter", mono: "JetBrains Mono" },
    motionMood: "confident",
    meta: { title: "Northwind: AI marketing agents that draft on your brand rules", description: "Northwind builds and runs AI marketing agents for B2B teams. A person approves before anything ships." },
    primaryCta: { label: "Book an intro call", href: "#contact" },
    sections: [
      { id: "nav", kind: "nav", purpose: "Orient and offer the one action." },
      { id: "hero", kind: "hero", purpose: "State what Northwind does and for whom.", headline: "AI agents that draft your marketing on your brand rules", body: "Twelve agents run in production today. A person approves before anything ships.", cta: { label: "Book an intro call", href: "#contact" } },
      { id: "how-it-works", kind: "how-it-works", purpose: "Show the three moves.", headline: "How it works", items: [{ title: "Point it at your brand" }, { title: "It drafts" }, { title: "You approve" }] },
      { id: "contact", kind: "cta", purpose: "Close.", headline: "Book an intro call", cta: { label: "Book an intro call", href: "#contact" } },
      { id: "footer", kind: "footer", purpose: "Legal and links." },
    ],
    carryForward: [],
    assets: [{ kind: "logo", url: "https://firebasestorage.googleapis.com/v0/b/x/o/logo.png?alt=media", alt: "Northwind", usage: "nav wordmark" }],
    sourcedFacts: ["Twelve agents run in production today."],
    bannedPhrases: ["replace your marketing team"],
    signatureMoment: "how-it-works: a running rule that draws itself down the numbered sequence on scroll.",
    assumptions: [],
    ...overrides,
  };
}

/** Parts that clear `checkPage` against `sampleBlueprint()`. */
export function sampleParts(overrides: Partial<PageParts> = {}): PageParts {
  return {
    css: `
:root{--ground:#f2f1ec;--ground-2:#ffffff;--fg:#1a1a1a;--fg-2:#4b4b4b;--accent:#ff6b2c;--edge:#dcd9d2;--ease:cubic-bezier(0.16,1,0.3,1)}
html{background:var(--ground);color:var(--fg)}
body{margin:0;font-family:"Inter",system-ui,sans-serif;line-height:1.6}
h1,h2{font-family:"Space Grotesk","Inter",sans-serif;line-height:1.05;margin:0}
.eyebrow{font-family:"JetBrains Mono",monospace;font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-2)}
section,header,footer{padding:clamp(3rem,8vw,7rem) clamp(1rem,5vw,4rem);max-width:1200px;margin:0 auto;box-sizing:border-box}
.btn{display:inline-block;background:var(--accent);color:#1a1a1a;padding:.9rem 1.4rem;border-radius:8px;text-decoration:none;font-weight:600}
.btn:focus-visible{outline:3px solid var(--fg);outline-offset:3px}
ol{display:grid;gap:2rem;padding:0;list-style:none}
`,
    sections: [
      { id: "nav", html: `<header id="nav"><a href="#hero"><img src="https://firebasestorage.googleapis.com/v0/b/x/o/logo.png?alt=media" alt="Northwind" width="120" height="32"></a><nav aria-label="Primary"><a href="#how-it-works">How it works</a><a class="btn" href="#contact">Book an intro call</a></nav></header>` },
      { id: "hero", html: `<section id="hero"><p class="eyebrow">AI marketing agents</p><h1>AI agents that draft your marketing on your brand rules</h1><p>Twelve agents run in production today. A person approves before anything ships.</p><a class="btn" href="#contact">Book an intro call</a></section>` },
      { id: "how-it-works", html: `<section id="how-it-works"><h2>How it works</h2><ol><li><span class="eyebrow">01</span> Point it at your brand</li><li><span class="eyebrow">02</span> It drafts</li><li><span class="eyebrow">03</span> You approve</li></ol></section>` },
      { id: "contact", html: `<section id="contact"><h2>Book an intro call</h2><a class="btn" href="#contact">Book an intro call</a></section>` },
      { id: "footer", html: `<footer id="footer"><p>Northwind. All rights reserved.</p></footer>` },
    ],
    script: `document.documentElement.classList.add("js");`,
    notes: [],
    ...overrides,
  };
}

export class MemoryArtifactStore implements GcsArtifactStoreLike {
  readonly bucketName = "test-bucket";
  readonly objects = new Map<string, Buffer>();
  async upload(objectPath: string, data: Buffer): Promise<ArtifactUploadResult> {
    this.objects.set(objectPath, data);
    return { objectPath, gcsUri: `gs://${this.bucketName}/${objectPath}`, signedUrl: `https://signed.example/${objectPath}` };
  }
  async download(objectPath: string): Promise<Buffer> {
    const found = this.objects.get(objectPath);
    if (!found) throw new Error(`no object ${objectPath}`);
    return found;
  }
  async exists(objectPath: string): Promise<boolean> {
    return this.objects.has(objectPath);
  }
}

/** A Firebase Hosting REST double: records every call, answers the exact sequence `FirebaseHostingClient` performs. */
export function fakeHostingFetch(options: { siteExists?: boolean; requiredHashes?: "all" | "none" } = {}) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  let siteExists = options.siteExists ?? false;
  const channels = new Set<string>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const rawBody = init?.body;
    const body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody instanceof Uint8Array ? `<${rawBody.byteLength} bytes>` : undefined;
    calls.push({ method, url, body });
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

    if (/\/projects\/[^/]+\/sites\/[^/?]+$/.test(url) && method === "GET") {
      return siteExists ? json(200, { name: "projects/p/sites/karos-northwind", defaultUrl: "https://karos-northwind.web.app" }) : json(404, { error: { code: 404 } });
    }
    if (/\/projects\/[^/]+\/sites\?siteId=/.test(url) && method === "POST") {
      siteExists = true;
      return json(200, { name: "projects/p/sites/karos-northwind", defaultUrl: "https://karos-northwind.web.app" });
    }
    if (/\/sites\/[^/]+\/versions$/.test(url) && method === "POST") return json(200, { name: "sites/karos-northwind/versions/v1", status: "CREATED" });
    if (url.endsWith(":populateFiles")) {
      const files = (body as { files: Record<string, string> }).files;
      const hashes = Object.values(files);
      return json(200, { uploadRequiredHashes: options.requiredHashes === "none" ? [] : hashes, uploadUrl: "https://upload.example/upload" });
    }
    if (url.startsWith("https://upload.example/upload/")) return new Response("", { status: 200 });
    if (/\/versions\/v1\?updateMask=status$/.test(url) && method === "PATCH") return json(200, { name: "sites/karos-northwind/versions/v1", status: "FINALIZED" });
    const channelGet = /\/sites\/[^/]+\/channels\/([^/?]+)$/.exec(url);
    if (channelGet && method === "GET") {
      const id = channelGet[1]!;
      return channels.has(id) || id === "live" ? json(200, { name: `sites/karos-northwind/channels/${id}`, url: `https://karos-northwind--${id}.web.app` }) : json(404, { error: { code: 404 } });
    }
    const channelCreate = /\/sites\/[^/]+\/channels\?channelId=([^&]+)$/.exec(url);
    if (channelCreate && method === "POST") {
      channels.add(channelCreate[1]!);
      return json(200, { name: `sites/karos-northwind/channels/${channelCreate[1]}`, url: `https://karos-northwind--${channelCreate[1]}.web.app` });
    }
    if (/\/channels\/[^/]+\/releases\?versionName=/.test(url) && method === "POST") return json(200, { name: "sites/karos-northwind/channels/x/releases/r1" });
    return json(500, { error: { message: `unexpected ${method} ${url}` } });
  };
  return { fetchImpl, calls };
}

export const fakeToken = { async getAccessToken() { return "test-token"; } };
