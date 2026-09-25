import { describe, expect, it } from "vitest";
import { sceneNamesForbiddenSubject } from "../src/workflow/visual-direction.js";

/**
 * Prep batch 6, karoslabs (pubsub-21792907400950482): the writer briefed
 * "ChatGPT interface on a dark desktop screen" and the client's direction
 * forbids "laptop, desktop monitor, or any illuminated screen". The generator
 * drew neither, and the floor vet refused the frame on all three attempts.
 */
describe("a brief whose subject the client's direction bans is rewritten for generation", () => {
  const karosForbid = ["laptop, desktop monitor, or any illuminated screen", "hands on a keyboard", "pure white or saturated colour that fights #f2f1ec", "legible text, signage, or logos in frame"];

  it("the batch 6 brief conflicts with the karoslabs direction", () => {
    expect(sceneNamesForbiddenSubject("ChatGPT interface on a dark desktop screen, clean and minimal, showing a conversation thread", karosForbid)).toBe(true);
    expect(sceneNamesForbiddenSubject("close-up of a keyboard mid-typing", karosForbid)).toBe(true);
  });

  it("a brief the direction does not ban, or a direction with no such ban, is left alone", () => {
    expect(sceneNamesForbiddenSubject("a relay baton mid-handoff between two runners", karosForbid)).toBe(false);
    // "white" in a colour rule is not a subject ban.
    expect(sceneNamesForbiddenSubject("a white ceramic cup on a stone bench", karosForbid)).toBe(false);
    expect(sceneNamesForbiddenSubject("a dashboard on a large screen", ["stock handshakes"])).toBe(false);
    expect(sceneNamesForbiddenSubject("a dashboard on a large screen", [])).toBe(false);
  });
});
