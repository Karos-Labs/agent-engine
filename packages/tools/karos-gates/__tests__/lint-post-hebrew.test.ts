import { describe, expect, it } from "vitest";

import { createKarosGatesTools } from "../src/index.js";
import type { GateVerdict } from "@agent-engine/core";

/**
 * THE TELLS WERE ONLY EVER BANNED IN ENGLISH.
 *
 * `gate.lintPost` runs on every agent's draft, and its phrase bank — the
 * corporate-enthusiasm openers, the throat-clearing, the engagement bait, the
 * sales tells — was English, every entry of it. A draft written for a client
 * who publishes in Hebrew could open with the exact announcement opener the
 * English list bans and close with the exact bait, and the gate called it
 * clean. `numbers-sourced.ts` records those clients as a third of the roster;
 * this is the same gap on the other shared gate.
 *
 * Two directions, and the second is the one that would bite in production:
 *
 *   1. the Hebrew tells now fail, the way their English twins always have;
 *   2. ORDINARY HEBREW STILL PASSES. A bank shared by six agents may only hold
 *      phrases that are wrong in every context, and a rule that fired on
 *      correct Hebrew would be worse for these clients than no rule at all —
 *      which is why `בשורה התחתונה`, `לסיכום` and `למעשה` are deliberately
 *      absent from it, exactly as "Let's", "Imagine" and "journey" are absent
 *      from the English list.
 */

async function verdictOf(text: string): Promise<GateVerdict> {
  const tool = createKarosGatesTools()["gate.lintPost"]!;
  const outcome = await tool.execute({ text, platform: "instagram" }, { ctx: { runId: "r", clientSlug: "c", productId: "p", runKind: "recurring", metadata: {} } });
  if (outcome.status !== "success") throw new Error(`gate.lintPost failed: ${outcome.status}`);
  return outcome.result as GateVerdict;
}

describe("the Hebrew tells fail, the way their English twins do", () => {
  it("refuses the announcement opener", async () => {
    const verdict = await verdictOf("נרגשים להודיע על שיתוף הפעולה החדש שלנו עם אחת מחברות הביטוח הגדולות בישראל.");
    expect(verdict.verdict).toBe("content_fail");
    expect(verdict.reason).toMatch(/נרגשים להודיע/);
  });

  it("refuses the fast-paced world and the dive", async () => {
    expect((await verdictOf("בעולם המהיר של ימינו קשה למצוא זמן לחשוב לעומק על אסטרטגיה.")).verdict).toBe("content_fail");
    expect((await verdictOf("בואו נצלול אל הנתונים של הרבעון האחרון ונראה מה הם אומרים.")).verdict).toBe("content_fail");
  });

  it("refuses the engagement bait and the sales tells", async () => {
    expect((await verdictOf("דעה לא פופולרית: רוב הקמפיינים לא נכשלים בתקציב אלא בתזמון.")).verdict).toBe("content_fail");
    expect((await verdictOf("ההטבה בתוקף לזמן מוגבל, אל תפספסו את ההזדמנות.")).verdict).toBe("content_fail");
  });

  it("names the phrase it found, so a redraft knows what to change", async () => {
    const verdict = await verdictOf("אנחנו גאים להציג את הגרסה החדשה, שמשנה את כללי המשחק בתחום.");
    expect(verdict.evidence.join(" ")).toMatch(/גאים להציג|משנה את כללי המשחק/);
  });
});

describe("ordinary Hebrew still passes", () => {
  it("passes a plain, well-written Hebrew post", async () => {
    const verdict = await verdictOf(
      "בדקנו 40 חשבונות בשוק הישראלי ומצאנו שרובם מפרסמים באותן שעות בדיוק. מי שזז שעתיים אחורה קיבל פי שניים תגובות.",
    );
    expect(verdict.verdict).toBe("pass");
  });

  it("passes the ordinary Hebrew the bank deliberately leaves out", async () => {
    // Each of these is a phrase a good Hebrew writer uses. Banning them would
    // be the English list's "Let's" mistake, in a language where this gate is
    // the only check some of these clients get.
    for (const text of [
      "בשורה התחתונה, שלושה מתוך ארבעה לקוחות חידשו את החוזה השנה.",
      "לסיכום, המספרים תומכים בהחלטה שקיבלנו ברבעון שעבר.",
      "למעשה, רוב הצוותים מגלים את זה רק אחרי החודש השני.",
    ]) {
      expect((await verdictOf(text)).verdict, text).toBe("pass");
    }
  });

  it("leaves an English draft answering exactly as it did", async () => {
    // The bank grew; it did not change for anybody who was already covered.
    expect((await verdictOf("We measured every queue in the study and published what we found.")).verdict).toBe("pass");
    expect((await verdictOf("Thrilled to announce our new partnership.")).verdict).toBe("content_fail");
  });
});
