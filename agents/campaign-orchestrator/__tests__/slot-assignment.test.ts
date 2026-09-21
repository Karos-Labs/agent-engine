import { describe, expect, it } from "vitest";

import { campaignSlotInput } from "../src/workflow/create-campaign-workflow.js";
import { readRunDirection } from "@agent-engine/workflow";
import type { CampaignChannelSlot } from "../src/agent/campaign-strategy-agent.js";

/**
 * THE ORCHESTRATOR HAS TO ACTUALLY ORCHESTRATE.
 *
 * `slot.targetAudience`, `slot.angle` and `slot.keyMessage` used to be read at
 * exactly ONE place in the whole workflow — building the guardrail text — while
 * every fan-out child inherited the parent's input verbatim. Each channel then
 * re-ran its own topic selection and wrote what it would have written
 * standalone, so a "campaign" was a plan document plus five unrelated posts
 * that happened to share a client. Everything `campaign-craft` teaches about
 * narrative alignment and per-channel angles was decorative.
 *
 * The second describe block is the one that matters: it feeds the result
 * through `readRunDirection`, the function every channel agent really calls, so
 * what is asserted is what a channel will actually see — not that a string was
 * assembled.
 */

const PLAN = { campaignName: "Q4 attribution", theme: "Marketers cannot see what AI says about them" };

function slot(patch: Partial<CampaignChannelSlot> = {}): CampaignChannelSlot {
  return {
    slotId: "slot_1",
    channel: "linkedin",
    targetAudience: "B2B marketing leads at 50-200 person SaaS companies",
    angle: "the measurement gap, told through one number",
    keyMessage: "Your attribution model cannot see what AI says about your brand",
    ...patch,
  };
}

describe("campaignSlotInput", () => {
  it("carries the key message as the channel's subject", () => {
    const input = campaignSlotInput({}, PLAN, slot());
    expect(input["requestedTopic"]).toBe("Your attribution model cannot see what AI says about your brand");
  });

  it("carries the angle, the audience and the campaign's own frame", () => {
    const prompt = String(campaignSlotInput({}, PLAN, slot())["customPrompt"]);
    expect(prompt).toContain("the measurement gap, told through one number");
    expect(prompt).toContain("B2B marketing leads");
    expect(prompt).toContain("Q4 attribution");
    expect(prompt).toContain("Marketers cannot see what AI says about them");
  });

  it("gives two channels of the same campaign genuinely different assignments", () => {
    // The failure this whole change is about: five slots that differed on
    // paper and produced five posts that had nothing to do with each other.
    const a = campaignSlotInput({}, PLAN, slot({ channel: "x", angle: "one hard number, no preamble", keyMessage: "AI answers are already choosing vendors" }));
    const b = campaignSlotInput({}, PLAN, slot());
    expect(a["requestedTopic"]).not.toBe(b["requestedTopic"]);
    expect(a["customPrompt"]).not.toBe(b["customPrompt"]);
  });

  it("KEEPS a person's own typed instruction and appends the assignment to it", () => {
    // If somebody typed something when they launched the campaign, it outranks
    // a plan the model wrote. Dropping it here would silently discard the one
    // input with a human behind it.
    const input = campaignSlotInput({ customPrompt: "Keep it short and do not mention pricing." }, PLAN, slot());
    const prompt = String(input["customPrompt"]);
    expect(prompt).toContain("Keep it short and do not mention pricing.");
    expect(prompt).toContain("the measurement gap");
    expect(prompt.indexOf("Keep it short")).toBeLessThan(prompt.indexOf("the measurement gap"));
  });

  it("passes everything else in the parent input through untouched", () => {
    const input = campaignSlotInput(
      { mediaAssets: [{ url: "https://example.com/a.png" }], mediaSource: "client-upload", somethingElse: 7 },
      PLAN,
      slot(),
    );
    expect(input["mediaAssets"]).toEqual([{ url: "https://example.com/a.png" }]);
    expect(input["mediaSource"]).toBe("client-upload");
    expect(input["somethingElse"]).toBe(7);
  });
});

describe("what the channel actually reads", () => {
  it("resolves to the plan's subject through readRunDirection, the seam every channel uses", () => {
    // Asserted through the real function rather than on the raw object,
    // because "a string was assembled" and "the channel will honour it" are
    // different claims and only the second one matters.
    const direction = readRunDirection(campaignSlotInput({}, PLAN, slot()));
    expect(direction.topicOverride).toBe("Your attribution model cannot see what AI says about your brand");
    expect(direction.direction).toContain("the measurement gap, told through one number");
  });

  it("does not let a long key message be demoted to a style note", () => {
    // `readRunDirection` applies a "does this look like a topic" heuristic to a
    // bare instruction, and deliberately does NOT apply it to an explicit
    // `requestedTopic`. A plan's key message is a full sentence, so routing it
    // through the instruction instead would have lost it.
    const long = "Marketers who spent a decade optimising for search rankings are now invisible in the answers their buyers actually read";
    const direction = readRunDirection(campaignSlotInput({}, PLAN, slot({ keyMessage: long })));
    expect(direction.topicOverride).toBe(long);
  });
});
