import { describe, expect, it } from "vitest";
import { normalizeCommentaryDashes, normalizeScriptDashes } from "../src/workflow/create-tiktok-agent-workflow.js";

/**
 * Prep run pubsub-21711047251391287 held at 07-compliance on one em dash in
 * a beat's narration. The script and commentary steps self-critique against
 * `gate.lintPost` now; these two helpers are the deterministic backstop, and
 * what they touch is exactly the set of fields the compliance step lints.
 */
describe("dash normalisation before compliance", () => {
  it("repairs every field a viewer hears or reads on a script, and nothing else", () => {
    const script = normalizeScriptDashes({
      hook: "Nobody tells you — the first hire is the one you fire.",
      beats: [
        { narration: "You hire for the company you have — and by month six it is another company.", onScreenText: "Month six — everything changes", visualBrief: "Whiteboard — wiped clean, marker residue in window light.", seconds: 6 },
      ],
      caption: "The first hire is a bet -- hire for the one you're becoming.",
      about: "An original short — founders should write early roles for the company they are turning into.",
      voiceover: true,
      voiceoverRationale: "A story — wants a voice.",
      language: "en-US",
    });
    expect(script.hook).toBe("Nobody tells you, the first hire is the one you fire.");
    expect(script.beats[0]!.narration).toBe("You hire for the company you have, and by month six it is another company.");
    expect(script.beats[0]!.onScreenText).toBe("Month six, everything changes");
    expect(script.caption).toBe("The first hire is a bet, hire for the one you're becoming.");
    expect(script.about).toBe("An original short, founders should write early roles for the company they are turning into.");
    // The visual brief goes to a video generator, never to a viewer, and the
    // rationale is read by a human reviewer; neither is published copy.
    expect(script.beats[0]!.visualBrief).toBe("Whiteboard — wiped clean, marker residue in window light.");
    expect(script.voiceoverRationale).toBe("A story — wants a voice.");
  });

  it("keeps the source credit a substring of the caption, which 07-compliance checks", () => {
    const commentary = normalizeCommentaryDashes({
      caption: "The number holds up, the takeaway does not — here's why. Via Jane Doe — The Show ep. 12.",
      about: "A clip — we disagree with the framing.",
      sourceCredit: "Jane Doe — The Show ep. 12",
    });
    expect(commentary.caption).toBe("The number holds up, the takeaway does not, here's why. Via Jane Doe, The Show ep. 12.");
    expect(commentary.sourceCredit).toBe("Jane Doe, The Show ep. 12");
    expect(commentary.caption).toContain(commentary.sourceCredit);
  });
});
