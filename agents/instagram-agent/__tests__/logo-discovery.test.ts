import { describe, expect, it } from "vitest";
import { homepageUrlFor, logoCandidatesFromHtml } from "../src/workflow/logo-discovery.js";

const PAGE = "https://www.hankypanky.com/";

describe("logoCandidatesFromHtml: the client's own mark, from its own homepage (2026-09-24)", () => {
  it("trusts the site's structured Organization logo first", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Hanky Panky","logo":{"@type":"ImageObject","url":"/img/hp-logo.svg"}}</script>
      <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
      </head><body><header><img class="site-logo" src="/header-logo.png" alt="Hanky Panky"></header></body></html>`;
    expect(logoCandidatesFromHtml(html, PAGE, "Hanky Panky")).toEqual([
      "https://www.hankypanky.com/img/hp-logo.svg",
      "https://www.hankypanky.com/header-logo.png",
      "https://www.hankypanky.com/apple-touch-icon.png",
    ]);
  });

  it("takes a logo image from the header, but never a partner's logo from a 'trusted by' strip further down", () => {
    const html = `<header><a href="/"><img src="https://cdn.example.com/brand/logo-dark.svg" alt="XO Digital"></a></header>
      <section class="trusted"><img src="/partners/acme-logo.png" alt="Acme logo"><img src="/partners/globex-logo.png" alt="Globex logo"></section>`;
    const found = logoCandidatesFromHtml(html, "https://xodigital.com.br/", "XO Digital");
    expect(found[0]).toBe("https://cdn.example.com/brand/logo-dark.svg");
    expect(found.some((u) => u.includes("acme") || u.includes("globex"))).toBe(false);
  });

  it("accepts a logo outside the header only when its file names the brand", () => {
    const html = `<div class="top"><img src="/assets/sitti-logo.png" alt=""><img src="/assets/visa-logo.png" alt="Visa"></div>`;
    expect(logoCandidatesFromHtml(html, "https://sitti.com/", "Sitti")).toEqual(["https://sitti.com/assets/sitti-logo.png"]);
  });

  it("offers the app icon, largest first, and never a small favicon", () => {
    const html = `<link rel="icon" href="/favicon-32.png" sizes="32x32"><link rel="icon" href="/icon-192.png" sizes="192x192">
      <link rel="apple-touch-icon" sizes="120x120" href="/touch-120.png"><link rel="apple-touch-icon" sizes="180x180" href="/touch-180.png">`;
    expect(logoCandidatesFromHtml(html, PAGE)).toEqual([
      "https://www.hankypanky.com/touch-180.png",
      "https://www.hankypanky.com/touch-120.png",
      "https://www.hankypanky.com/icon-192.png",
    ]);
  });

  it("returns only https URLs, deduplicated, and nothing for a page without a mark", () => {
    const html = `<header><img class="logo" src="http://insecure.example/logo.png"><img class="logo" src="/logo.png"><img class="logo" src="/logo.png"></header>`;
    expect(logoCandidatesFromHtml(html, PAGE)).toEqual(["https://www.hankypanky.com/logo.png"]);
    expect(logoCandidatesFromHtml("<html><body><p>hello</p></body></html>", PAGE)).toEqual([]);
    // Geektime's live JSON-LD names its homepage as its logo; a page is not a file.
    const geektime = `<script type="application/ld+json">{"@type":"Organization","logo":"https://www.geektime.co.il/"}</script><header><img src="https://cdn.geektime.co.il/geektime-logo-2.svg" alt="Geektime"></header>`;
    expect(logoCandidatesFromHtml(geektime, "https://www.geektime.co.il/", "Geektime")).toEqual(["https://cdn.geektime.co.il/geektime-logo-2.svg"]);
  });
});

describe("homepageUrlFor", () => {
  it("normalises what a client record calls its site to an https homepage", () => {
    expect(homepageUrlFor("hankypanky.com")).toBe("https://hankypanky.com/");
    expect(homepageUrlFor("http://www.geektime.co.il/some/page")).toBe("https://www.geektime.co.il/");
    expect(homepageUrlFor("  ")).toBeUndefined();
    expect(homepageUrlFor("not a site")).toBeUndefined();
    expect(homepageUrlFor(undefined)).toBeUndefined();
  });
});
