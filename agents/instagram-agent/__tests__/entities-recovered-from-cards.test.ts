import { describe, expect, it } from "vitest";
import { CARD_ENTITY_MENTION_FLOOR, entitiesInCards } from "../src/workflow/draft-entities.js";

/**
 * ── "IBM IS EXPLICITLY MENTIONED — HOW IS THERE NO IMAGE OF THEM?" ──
 *
 * The owner, 2026-09-20, on thepitchbydeel's carousel.
 *
 * `IBM` appears nine times across `pubsub-21905062348134898`'s fact cards, in
 * the draft, and on the rendered slides. `04b3-extract-entities` returned
 * exactly ONE entity: `nybl`. Every picture slide was then briefed with that
 * one subject, which is also why the frames came back looking like each other
 * — the owner's other note, same root cause.
 *
 * `04b3` is a model step and its failure mode is silent: a short list is
 * exactly what a correct answer looks like, so nothing downstream could tell
 * "this post has one subject" from "I found one subject". This is the
 * deterministic second opinion, and these cases are built from the run's own
 * card text.
 */

const card = (claim: string) => ({ claim });

/** Claims in the shape `pubsub-21905062348134898` carried them. */
const DEEL_CARDS = [
  card("After Paris, nybl entered a global scaling partnership with IBM to reach new markets."),
  card("The IBM partnership gives nybl access to enterprise buyers across the Gulf."),
  card("nybl's platform runs on GCC infrastructure and cut safety incidents by 50%."),
  card("IBM will co-sell the platform through its existing enterprise channel."),
];

describe("names the extractor dropped", () => {
  it("recovers IBM, which the model returned none of", () => {
    const recovered = entitiesInCards(DEEL_CARDS, ["nybl"], ["thepitchbydeel"]);
    expect(recovered.map((e) => e.name)).toContain("IBM");
  });

  it("does not re-report what the model already found", () => {
    // `known` is the extractor's own answer. Reporting it back would double
    // every entity and make the merge downstream meaningless.
    const recovered = entitiesInCards(DEEL_CARDS, ["nybl", "IBM"], []);
    expect(recovered.map((e) => e.name)).not.toContain("IBM");
  });

  it("ignores the client's own name", () => {
    const own = entitiesInCards([card("A client writes that Acme Corp did well."), card("Acme Corp again."), card("And Acme Corp once more.")], [], ["Acme Corp"]);
    expect(own.map((e) => e.name)).not.toContain("Acme Corp");
  });

  it("holds a frequency floor, so a place named once is not something to photograph", () => {
    // The same cards mention Paris and the Gulf. Neither is a subject anyone
    // wants a picture of here, and neither clears the floor.
    const recovered = entitiesInCards(DEEL_CARDS, ["nybl"], []);
    for (const incidental of ["Paris", "Gulf", "GCC"]) {
      expect(recovered.map((e) => e.name)).not.toContain(incidental);
    }
  });

  it("requires the name in MORE THAN ONE card, not just repeated inside one", () => {
    // A single card that says a name three times is that card's phrasing, not
    // evidence the post is about it.
    const oneCard = [card("Contoso said Contoso would ship, and Contoso shipped."), card("Unrelated claim.")];
    expect(entitiesInCards(oneCard, [], [])).toEqual([]);
  });

  it("does not admit a name that only ever opens its sentence", () => {
    // `latinNamesIn` skips the first word of a sentence, which is right for
    // its own job and is why the mention floor is 2 rather than 3: one of
    // IBM's real mentions opens its sentence and is never counted. A name
    // that ONLY ever opens one contributes nothing at all, which is the
    // honest limit of this backstop and is asserted rather than hidden.
    const onlyInitial = [card("Northwind grows fast."), card("Northwind again today.")];
    expect(entitiesInCards(onlyInitial, [], [])).toEqual([]);
    expect(CARD_ENTITY_MENTION_FLOOR).toBe(2);
  });

  it("returns no slides, because a card belongs to no slide", () => {
    // The caller assigns them. A recovered name that claimed a slide would
    // silently outrank the draft's own reading of which slide names what.
    for (const e of entitiesInCards(DEEL_CARDS, ["nybl"], [])) {
      expect(e.slides).toEqual([]);
      expect(e.inHeadline).toBe(false);
    }
  });

  it("survives empty and malformed cards without throwing", () => {
    expect(entitiesInCards([], [], [])).toEqual([]);
    expect(entitiesInCards([{ claim: undefined }, { claim: "" }], [], [])).toEqual([]);
  });
});
