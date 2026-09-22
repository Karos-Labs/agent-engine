import { describe, expect, it } from "vitest";

import { createKarosGatesTools } from "../src/index.js";
import type { GateVerdict } from "@agent-engine/core";

/**
 * THE SHEKEL WAS NEVER CHECKED — which is not the same as being refused.
 *
 * `gate.numbersSourced` knew `$`, `€` and `£`. A figure in ₪ matched no claim
 * pattern at all, so an agent writing for an Israeli client could state any sum
 * in shekels and the gate would pass the draft without looking, while the same
 * sentence in dollars had to be traceable to a source. Clients writing natively
 * in Hebrew are a third of the roster.
 *
 * Two directions matter and both are asserted below, because a change that only
 * made shekel figures FAIL would be as wrong as the silence it replaced:
 *
 *   1. an unsourced shekel figure now fails, the way an unsourced dollar figure
 *      always has;
 *   2. a shekel figure the draft quotes from its source PASSES, across the
 *      spellings Hebrew actually uses — sign before or after the number, the
 *      written-out currency, the ISO codes, and the Hebrew magnitude words.
 *
 * The second is the one that would bite in production: a gate that fails an
 * honest draft costs a redraft and, at the ceiling, a hold.
 */

async function verdictOf(text: string, sources?: string[]): Promise<GateVerdict> {
  const tool = createKarosGatesTools()["gate.numbersSourced"]!;
  const outcome = await tool.execute(
    sources ? { text, sources } : { text },
    { ctx: {} as never },
  );
  if (outcome.status !== "success") throw new Error(`tool did not succeed: ${outcome.status}`);
  return outcome.result as GateVerdict;
}

describe("gate.numbersSourced — Hebrew and the shekel", () => {
  describe("an unsourced shekel figure is now caught", () => {
    it("fails a bare ₪ figure with no sources at all", async () => {
      expect((await verdictOf("ההכנסות הגיעו ל-1,200,000 ₪ ברבעון.")).verdict).toBe("content_fail");
    });

    it("fails a ₪ figure whose attached source does not carry it", async () => {
      const v = await verdictOf("החברה גייסה 45 מיליון ₪.", ["דוח רבעוני, ללא נתוני גיוס"]);
      expect(v.verdict).toBe("content_fail");
    });

    it("fails an ILS figure, the ISO spelling", async () => {
      expect((await verdictOf("Revenue reached ILS 4.2 million this quarter.")).verdict).toBe("content_fail");
    });
  });

  describe("a shekel figure the draft actually sourced passes", () => {
    it("passes the sign AFTER the number, which is how Hebrew usually writes it", async () => {
      const v = await verdictOf("ההכנסות הגיעו ל-1,200 ₪.", ["ההכנסות הגיעו ל-1,200 ₪ ברבעון השלישי."]);
      expect(v.verdict).toBe("pass");
    });

    it("passes when the draft writes the sign first and the source writes it last", async () => {
      // The whole reason both orders fold to one normal form: a draft quoting
      // its source verbatim must not fail its own check on punctuation order.
      const v = await verdictOf("הסבב הסתיים ב-₪45,000,000.", ["הסבב הסתיים ב-45,000,000 ₪."]);
      expect(v.verdict).toBe("pass");
    });

    it('passes the written-out currency against the sign', async () => {
      const v = await verdictOf("המחיר הוא 890 שקלים לחודש.", ["המחיר הוא 890 ₪ לחודש."]);
      expect(v.verdict).toBe("pass");
    });

    it("passes a Hebrew magnitude word against the same figure written in digits", async () => {
      const v = await verdictOf("החברה גייסה 45 מיליון ₪.", ["החברה גייסה 45 מיליון ₪ בסבב האחרון."]);
      expect(v.verdict).toBe("pass");
    });

    it("passes ILS in the draft against ₪ in the source", async () => {
      const v = await verdictOf("Revenue reached ILS 4.2 million.", ["Revenue reached ₪4.2 million."]);
      expect(v.verdict).toBe("pass");
    });
  });

  describe("what must not change", () => {
    it("still passes Hebrew prose that carries no numeric claim", async () => {
      expect((await verdictOf("השקנו מוצר חדש והקהילה הגיבה יפה.")).verdict).toBe("pass");
    });

    it("still fails an unsourced dollar figure", async () => {
      // The control. If this ever stops failing, the change above widened
      // something it should not have.
      expect((await verdictOf("Revenue grew to $4.2 million.")).verdict).toBe("content_fail");
    });

    it("does not read an ordinary Hebrew year or count as a currency claim", async () => {
      // "אלף" folds to a magnitude, so a sentence with a plain number and no
      // currency must still be judged on the existing rules rather than
      // becoming a new class of failure.
      expect((await verdictOf("הצוות שלנו מונה שבעה אנשים.")).verdict).toBe("pass");
    });
  });
});
