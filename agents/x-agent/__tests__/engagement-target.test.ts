import { describe, expect, it } from "vitest";
import { readEngagementTarget, UNVERIFIED_TARGET_NOTE } from "../src/workflow/engagement-target.js";
import { renderXDraftsMarkdown } from "../src/workflow/render-drafts-markdown.js";
import type { XPostOutput } from "../src/agent/x-draft-agent.js";

/**
 * A CITATION NOBODY CHECKED.
 *
 * The `engagement` lane aims a reply or a quote at one specific post, and
 * `targetPostHandle`/`targetPostUrl` say which. Nothing in this agent ever
 * read either field: they came out of the drafting model, passed a
 * `z.string().url()` that accepts `https://example.com`, and went onto the
 * deliverable, where the renderer printed
 *
 *     **In reply to:** <that URL>
 *
 * No tool here fetches a post. A reviewer was reading, in citation form, a
 * statement of which post the client was about to reply to — invented.
 *
 * What is fixable and what is not, stated plainly, because the difference is
 * the whole design: this CANNOT establish that the post exists (that costs an
 * API tier this agent does not have). It establishes the URL is shaped like
 * an X post at all, that the draft does not contradict itself, and that the
 * reviewer is told nobody opened it.
 */

const base: XPostOutput = {
  text: "Most pricing pages answer the wrong question.",
  mainPostText: "Most pricing pages answer the wrong question.",
  hook: "Most pricing pages answer the wrong question.",
  angle: "pricing",
  lane: "engagement",
  targetHandle: "getkaros",
  mediaRefs: [],
  thread: [],
} as unknown as XPostOutput;

const draft = (over: Partial<XPostOutput>): XPostOutput => ({ ...base, ...over });

describe("the post an engagement reply names", () => {
  it("accepts a real X post URL and reports the handle the URL itself carries", () => {
    const verdict = readEngagementTarget(draft({ targetPostHandle: "@patio11", targetPostUrl: "https://x.com/patio11/status/1790000000000000001" }));
    expect(verdict.kind).toBe("usable");
    if (verdict.kind !== "usable") throw new Error("unreachable");
    // The handle comes from the URL, not from the field beside it: only one of
    // the two is part of the thing a reviewer will open.
    expect(verdict.target.handle).toBe("patio11");
    expect(verdict.target.url).toBe("https://x.com/patio11/status/1790000000000000001");
  });

  it("accepts the twitter.com and mobile spellings, and a URL carrying tracking junk", () => {
    // All three are what a person actually pastes. Refusing them would make
    // the check punish correct targets, which is how a guard gets switched off.
    for (const url of [
      "https://twitter.com/patio11/status/1790000000000000001",
      "https://mobile.x.com/patio11/status/1790000000000000001",
      "https://x.com/patio11/status/1790000000000000001?s=20&t=abc",
    ]) {
      expect(readEngagementTarget(draft({ targetPostUrl: url })).kind, url).toBe("usable");
    }
  });

  it("refuses a URL that is not an X post at all", () => {
    // THE DEFECT, in one line: this passed `z.string().url()` and was printed
    // as a citation.
    const verdict = readEngagementTarget(draft({ targetPostHandle: "patio11", targetPostUrl: "https://example.com" }));
    expect(verdict.kind).toBe("unusable");
    if (verdict.kind !== "unusable") throw new Error("unreachable");
    expect(verdict.reason).toContain("is not an X post URL");
  });

  it("refuses a profile URL with no post on it, and a bare handle with no post", () => {
    expect(readEngagementTarget(draft({ targetPostUrl: "https://x.com/patio11" })).kind).toBe("unusable");
    const noUrl = readEngagementTarget(draft({ targetPostHandle: "patio11", targetPostUrl: "" }));
    expect(noUrl.kind).toBe("unusable");
    if (noUrl.kind !== "unusable") throw new Error("unreachable");
    expect(noUrl.reason).toContain("gave no post to reply to");
  });

  it("refuses a draft that contradicts itself, rather than picking a half to believe", () => {
    const verdict = readEngagementTarget(draft({ targetPostHandle: "patio11", targetPostUrl: "https://x.com/someone_else/status/1790000000000000001" }));
    expect(verdict.kind).toBe("unusable");
    if (verdict.kind !== "unusable") throw new Error("unreachable");
    expect(verdict.reason).toContain("@patio11");
    expect(verdict.reason).toContain("@someone_else");
  });

  it("treats a target on any other lane as absent, never as a repair", () => {
    // The schema's own comment records sonnet filling these fields on lanes
    // where they mean nothing (prep run pubsub-21483237815948874). Dropping
    // one there is housekeeping; a ledger row for it would be noise that
    // reclassifies every clean knowledge post as repaired — which would also
    // push its gate from the 1h clean tier to the 6h flagged one.
    const verdict = readEngagementTarget(draft({ lane: "knowledge", targetPostUrl: "https://example.com" }));
    expect(verdict.kind).toBe("absent");
  });
});

describe("what the deliverable prints", () => {
  const goalLine = { goal: "start a conversation", goalText: "start a conversation", whyNow: "their thread is live" } as never;

  it("prints the reply line for a usable target, under the label karosCMO parses", () => {
    const md = renderXDraftsMarkdown({
      targetHandle: "getkaros",
      lane: "engagement",
      angle: "pricing",
      draft: draft({ targetPostHandle: "patio11", targetPostUrl: "https://x.com/patio11/status/1790000000000000001" }),
      goalLine,
    });
    // THE LABEL IS A CROSS-REPO CONTRACT and is asserted verbatim:
    // karosCMO's `x-drafts.ts` matches `^(?:in\s+)?repl(?:y|ying)(?:\s+(?:to|target|post))?$`
    // on the label, ANCHORED, and that is what decides whether a client's
    // reply gets addressed at this URL. Rewording it to carry the warning
    // would be a silent break dressed as an improvement — which is why the
    // warning lives on the gate payload instead.
    expect(md).toContain("- **In reply to:** https://x.com/patio11/status/1790000000000000001");
  });

  it("prints NO reply line at all when the target is invented", () => {
    const md = renderXDraftsMarkdown({
      targetHandle: "getkaros",
      lane: "engagement",
      angle: "pricing",
      draft: draft({ targetPostHandle: "patio11", targetPostUrl: "https://example.com" }),
      goalLine,
    });
    // A missing line is a gap a reviewer notices. A fabricated one is a gap
    // they cannot.
    expect(md).not.toContain("In reply to");
    expect(md).not.toContain("example.com");
    // And the post itself still ships — the owner's always-deliver rule.
    expect(md).toContain("Most pricing pages answer the wrong question.");
  });
});

describe("the warning a reviewer reads", () => {
  it("says who checked, which is nobody", () => {
    // Not decoration. The gate is the one surface where this can be said
    // without breaking a parser, and a target with no such line reads as a
    // fact the run established.
    expect(UNVERIFIED_TARGET_NOTE).toContain("nobody fetched this post");
    expect(UNVERIFIED_TARGET_NOTE).toContain("before approving");
  });
});
