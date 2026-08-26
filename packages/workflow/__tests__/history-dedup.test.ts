import { describe, expect, it } from "vitest";
import { buildClientIntelContext, buildClientKnowledgeContext, dedupeDirective, dedupeRetryDirective } from "../src/index.js";
import { evaluateDedupe } from "@agent-engine/core";

describe("dedupeDirective", () => {
  it("returns undefined for an empty history, so a first run's prompt is byte-identical to before", () => {
    expect(dedupeDirective([])).toBeUndefined();
  });

  it("formats the most recent posts as hard do-not-repeat constraints, bounded", () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ runId: `r${i}`, excerpt: `post number ${i} about topic ${i}` }));
    const directive = dedupeDirective(history)!;
    expect(directive).toContain("Do not repeat them");
    // Bounded to the most recent 8 — history must not crowd out the brief.
    expect(directive).not.toContain("post number 3 ");
    expect(directive).toContain("post number 11");
  });
});

describe("dedupeRetryDirective", () => {
  it("quotes the offending post so the model knows exactly what to move away from", () => {
    const history = [{ runId: "r1", excerpt: "five automation wins from this quarter, ranked" }];
    const verdict = evaluateDedupe("five automation wins from this quarter, ranked", history);
    expect(verdict.status).toBe("similar");
    const directive = dedupeRetryDirective(verdict, history);
    expect(directive).toContain("% overlap");
    expect(directive).toContain("five automation wins");
  });
});

describe("buildClientIntelContext", () => {
  it("distills only the copy-steering fields, bounded", () => {
    const context = buildClientIntelContext({
      brandVoiceRows: ["Confident, never boastful", "Hebrew-first, English for product names"],
      brandVoiceArchetypes: ["Sage", "Explorer"],
      brandVoiceTerritory: "The engineer's translator",
      positioningAnalysis: "P".repeat(5000),
      whitespaceOpportunities: ["AI compliance for SMBs"],
      dimensionScores: [{ ignored: true }],
      swot: { strengths: ["ignored"] },
    })!;
    expect(context).toContain("Confident, never boastful");
    expect(context).toContain("Sage, Explorer");
    expect(context).toContain("The engineer's translator");
    expect(context).toContain("AI compliance for SMBs");
    // The positioning prose is capped, and non-copy fields never appear.
    expect(context.length).toBeLessThan(2500);
    expect(context).not.toContain("ignored");
  });

  it("returns undefined when nothing usable exists, so clients without a report see zero change", () => {
    expect(buildClientIntelContext(undefined)).toBeUndefined();
    expect(buildClientIntelContext(null)).toBeUndefined();
    expect(buildClientIntelContext({})).toBeUndefined();
    expect(buildClientIntelContext({ brandVoiceRows: [] })).toBeUndefined();
  });
});

describe("buildClientKnowledgeContext", () => {
  it("labels each doc by type, slices its content, and marks the whole block authoritative", () => {
    const context = buildClientKnowledgeContext({
      contextDocs: [
        { docType: "brand-voice", tier: "client", version: 3, content: "We write like the engineer's translator. " + "V".repeat(3000) },
        { docType: "icp", tier: "internal", version: 1, content: "Mid-market CTOs in regulated industries." },
      ],
      transcripts: [{ title: "Q4 kickoff", meetingDate: 5, summary: "Agreed to lead with the compliance story. " + "S".repeat(1000) }],
      assets: [{ name: "hero.png", mimeType: "image/png", url: "https://x/hero.png" }],
    })!;
    expect(context).toContain("authoritative");
    expect(context).toContain("### brand-voice");
    expect(context).toContain("### icp");
    expect(context).toContain("Mid-market CTOs");
    expect(context).toContain("- Q4 kickoff — Agreed to lead with the compliance story.");
    // Per-doc and per-meeting slices hold — the knowledge layer augments the
    // brief, it must never displace it.
    expect(context.length).toBeLessThan(2 * 1200 + 300 + 400);
    // The asset index is a file listing, not drafting context.
    expect(context).not.toContain("hero.png");
  });

  it("bounds the doc and meeting counts", () => {
    const context = buildClientKnowledgeContext({
      contextDocs: Array.from({ length: 12 }, (_, i) => ({ docType: `doc-${i}`, tier: "client", version: 1, content: `content ${i}` })),
      transcripts: Array.from({ length: 12 }, (_, i) => ({ title: `Meeting ${i}` })),
    })!;
    expect(context).toContain("### doc-5");
    expect(context).not.toContain("### doc-6");
    expect(context).toContain("- Meeting 4");
    expect(context).not.toContain("- Meeting 5");
  });

  it("returns undefined when the sync has never run or mirrored nothing, so those clients see zero prompt change", () => {
    expect(buildClientKnowledgeContext(undefined)).toBeUndefined();
    expect(buildClientKnowledgeContext(null)).toBeUndefined();
    expect(buildClientKnowledgeContext({})).toBeUndefined();
    expect(buildClientKnowledgeContext({ contextDocs: [], transcripts: [], assets: [] })).toBeUndefined();
    expect(buildClientKnowledgeContext({ contextDocs: [{ docType: "x", tier: "client", version: 1, content: "   " }] })).toBeUndefined();
  });
});
