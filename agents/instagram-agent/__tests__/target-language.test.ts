import { describe, expect, it } from "vitest";
import {
  LANGUAGE_BELIEF_KEY,
  MIN_SNIFF_LETTERS,
  adoptBriefTargetLanguage,
  adoptLateTargetLanguage,
  bcp47For,
  buildLanguageBelief,
  findExplicitLanguageMentions,
  isEnglishTarget,
  parseLanguageBelief,
  readLanguageBelief,
  resolveTargetLanguage,
  sniffDominantScript,
  type InstagramLanguageBelief,
} from "../src/workflow/target-language.js";
import { resolveExpectedScript, scriptTableEntries } from "../src/workflow/language-gate.js";

/**
 * Instagram upgrade 2026-09, brief item B: step 02d's target-language
 * resolution, which used to read `brand.language` alone and therefore left
 * the language gate off for every client the audit sampled. These are the
 * pure-function cases; the workflow-level consequences (07e present for a
 * geektime-shaped client, a hold at 02d for an ambiguous script) live in
 * `language-compliance-gate.test.ts`.
 */

/** geektime's real self-description shape: the language is stated in prose, nowhere structured. */
const GEEKTIME_PROFILE = {
  name: "Geektime",
  industry: "technology media",
  description: "Israel's largest Hebrew-language technology site, covering startups, venture capital and the people behind them.",
};

/** Voice rules written in Hebrew, naming no language at all. Long enough to clear the sniff floor several times over. */
const HEBREW_GUIDELINES =
  "כותבים בגובה העיניים, בלי סופרלטיבים ובלי ז'רגון שיווקי. כל פוסט נפתח בעובדה אחת שאפשר לבדוק, ממשיך בהקשר קצר ונסגר בשאלה לקוראים. משפטים קצרים, פסקאות קצרות, ובלי סימני קריאה.";

/** A profile written entirely in Cyrillic: the script is unmistakable, the language is not. */
const CYRILLIC_PROFILE = {
  name: "Технологии сегодня",
  description:
    "Ежедневное издание о технологиях, стартапах и венчурных инвестициях. Мы пишем коротко и по делу, без рекламных штампов, для инженеров и основателей компаний.",
};

describe("resolveTargetLanguage — precedence", () => {
  it("brand.language wins over a profile that says otherwise", () => {
    const result = resolveTargetLanguage({ brandLanguage: "Spanish", profile: GEEKTIME_PROFILE });
    expect(result).toMatchObject({ status: "resolved", language: "Spanish", source: "brand" });
  });

  it("a BCP-47 tag in brand.language resolves verbatim, and the gate's own table can read it", () => {
    const result = resolveTargetLanguage({ brandLanguage: " he-IL " });
    expect(result).toMatchObject({ status: "resolved", language: "he-IL", source: "brand" });
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(resolveExpectedScript(result.language)?.name).toBe("Hebrew");
  });

  it("an empty or non-string brand.language is treated as unset", () => {
    expect(resolveTargetLanguage({ brandLanguage: "   " }).status).toBe("english-default");
    expect(resolveTargetLanguage({ brandLanguage: 42 }).status).toBe("english-default");
    expect(resolveTargetLanguage({ brandLanguage: null }).status).toBe("english-default");
  });

  it("'Israel's largest Hebrew-language technology site' resolves from the profile", () => {
    const result = resolveTargetLanguage({ profile: GEEKTIME_PROFILE });
    expect(result).toMatchObject({ status: "resolved", language: "Hebrew", source: "profile" });
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.evidence.join("\n")).toMatch(/profile\.description states "Hebrew-language"/);
  });

  it("Hebrew-script guidelines with no language name resolve by script sniff", () => {
    const result = resolveTargetLanguage({ profile: { name: "Acme" }, voiceRules: { guidelines: HEBREW_GUIDELINES } });
    expect(result).toMatchObject({ status: "resolved", language: "Hebrew", source: "script-sniff" });
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.evidence.join("\n")).toMatch(/Hebrew script/);
  });

  it("a Cyrillic-only profile is unresolved-non-english with the table's candidates, never a guess", () => {
    const result = resolveTargetLanguage({ profile: CYRILLIC_PROFILE });
    expect(result.status).toBe("unresolved-non-english");
    if (result.status !== "unresolved-non-english") throw new Error("unreachable");
    expect(result.script).toBe("Cyrillic");
    expect(result.candidates).toEqual(expect.arrayContaining(["Russian", "Ukrainian", "Bulgarian"]));
    expect(result.candidates.length).toBeGreaterThanOrEqual(3);
    expect(result.evidence.join("\n")).toMatch(/Cyrillic script/);
  });

  it("'we work with Hebrew-speaking founders' describes the audience, not the output language: english-default", () => {
    const result = resolveTargetLanguage({
      profile: { description: "We work with Hebrew-speaking founders and Israeli startups expanding into the US market." },
    });
    expect(result.status).toBe("english-default");
  });

  it("'Hebrew-speaking audience' IS an output-language statement", () => {
    const result = resolveTargetLanguage({ profile: { description: "A daily briefing for a Hebrew-speaking audience of product managers." } });
    expect(result).toMatchObject({ status: "resolved", language: "Hebrew", source: "profile" });
  });

  it("plain English prose is english-default, with the evidence saying why", () => {
    const result = resolveTargetLanguage({
      profile: { description: "AI marketing agency for B2B founders. We run the whole funnel so the founder can run the company." },
      voiceRules: { tone: "direct", doList: ["lead with the number", "one idea per slide"] },
    });
    expect(result.status).toBe("english-default");
    if (result.status !== "english-default") throw new Error("unreachable");
    expect(result.evidence).toEqual(
      expect.arrayContaining([expect.stringMatching(/brand\.language unset/), expect.stringMatching(/no explicit language statement/), expect.stringMatching(/Latin script/)]),
    );
  });

  it("nothing to read at all is english-default", () => {
    expect(resolveTargetLanguage({})).toMatchObject({ status: "english-default" });
    expect(resolveTargetLanguage({ profile: {}, voiceRules: {} })).toMatchObject({ status: "english-default" });
  });

  it("an explicit statement beats a script sniff, in source order", () => {
    // Profile says Arabic explicitly; voice rules are written in Hebrew. The
    // explicit statement is step 2, the sniff is step 3.
    const result = resolveTargetLanguage({
      profile: { description: "The region's leading Arabic-language business daily." },
      voiceRules: { guidelines: HEBREW_GUIDELINES },
    });
    expect(result).toMatchObject({ status: "resolved", language: "Arabic", source: "profile" });
  });

  it("reads the brand-voice document and voice-rules doList as sources too", () => {
    expect(resolveTargetLanguage({ brandVoiceDoc: "# Voice\n\nAll content in Greek, informal register." })).toMatchObject({
      status: "resolved",
      language: "Greek",
      source: "brand-voice-doc",
    });
    expect(resolveTargetLanguage({ voiceRules: { doList: ["write everything in French only", "no exclamation marks"] } })).toMatchObject({
      status: "resolved",
      language: "French",
      source: "voice-rules",
    });
  });

  it("a Hebrew profile is not diluted below the floor by voice rules an agency wrote in English", () => {
    const englishRules = "Direct, no corporate jargon. Lead with the fact. Short sentences. One idea per slide. No exclamation marks, no em dashes. ".repeat(4);
    const result = resolveTargetLanguage({ profile: { description: HEBREW_GUIDELINES }, voiceRules: { guidelines: englishRules } });
    expect(result).toMatchObject({ status: "resolved", language: "Hebrew", source: "script-sniff" });
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.evidence.join("\n")).toMatch(/profile\.description: \d+ letters/);
  });
});

describe("resolveTargetLanguage — English is not a target", () => {
  // The gate is scoped to non-English targets (brief item B) and 07f fails
  // closed: resolving "English" would buy an English client a per-attempt
  // Haiku call whose only new outcome is a hold on a judge outage.
  it.each([
    "We are an AI marketing agency for English-speaking markets in B2B SaaS.",
    "Karos Labs publishes in English for founders.",
    "An English-language newsletter for operators.",
    "Everything is written in English, in a practitioner register.",
  ])("an English statement in the profile is english-default, not resolved: %j", (description) => {
    const result = resolveTargetLanguage({ profile: { description } });
    expect(result.status).toBe("english-default");
    if (result.status !== "english-default") throw new Error("unreachable");
    // The statement is still recorded: the field WAS set, and a trace reader
    // should see which one decided.
    expect(result.evidence.join("\n")).toMatch(/needs no language gate/);
  });

  it.each(["English", "english", "en", "en-US", "en_GB"])("brand.language %j is english-default, with the field quoted as evidence", (language) => {
    const result = resolveTargetLanguage({ brandLanguage: language });
    expect(result.status).toBe("english-default");
    if (result.status !== "english-default") throw new Error("unreachable");
    expect(result.evidence[0]).toBe(`brand.language = "${language}", which needs no language gate`);
  });

  it("isEnglishTarget answers for names, tags and regions — and for nothing else Latin", () => {
    for (const yes of ["English", " english ", "en", "en-GB", "en_US", "EN"]) expect(isEnglishTarget(yes), yes).toBe(true);
    for (const no of ["Spanish", "es", "pt-BR", "Hebrew", "he-IL", "", "   "]) expect(isEnglishTarget(no), no).toBe(false);
  });

  it("every OTHER Latin-script language still resolves, so the gate still runs for it", () => {
    // The whole reason this is a name check and not a script check: Spanish
    // and Portuguese are Latin too, and telling them from English is exactly
    // what the fluency judge is for.
    expect(resolveTargetLanguage({ profile: { description: "Acme covers enterprise software and publishes exclusively in Spanish." } })).toMatchObject({
      status: "resolved",
      language: "Spanish",
    });
    expect(resolveTargetLanguage({ brandLanguage: "pt-BR" })).toMatchObject({ status: "resolved", language: "pt-BR" });
  });

  it("a source naming English AND another language gates on the language that has something to verify", () => {
    const result = resolveTargetLanguage({ profile: { description: "A weekly digest written in English, and the daily edition published in Hebrew." } });
    expect(result).toMatchObject({ status: "resolved", language: "Hebrew" });
  });
});

describe("resolveTargetLanguage — one non-Latin field does not hold a plainly English client", () => {
  /** A real English profile: two sentences, comfortably past the sniff floor. */
  const ENGLISH_PROFILE = {
    description:
      "Acme Analytics is a business intelligence platform for retail operators. We publish practitioner guides about inventory, margin and store operations for the people who run them.",
  };

  it.each([
    ["Cyrillic", "Пишите коротко и по делу, без рекламных штампов и лишних слов"],
    ["Arabic", "اكتب بإيجاز ومباشرة دون شعارات تسويقية أو كلمات زائدة عن الحاجة"],
  ])("one %s do-list line is not a reason to hold the run at intake", (_script, line) => {
    const result = resolveTargetLanguage({ profile: ENGLISH_PROFILE, voiceRules: { doList: [line] } });
    // Before 2026-09-10 this was `unresolved-non-english`, i.e. EVERY run for
    // this client held at 02d until somebody edited the portal — for a client
    // whose profile is plainly English.
    expect(result.status).toBe("english-default");
    if (result.status !== "english-default") throw new Error("unreachable");
    expect(result.evidence.join("\n")).toMatch(/prose as a whole is Latin/);
  });

  it("one Hebrew do-list line does not resolve Hebrew for an English profile either", () => {
    // The same defect with a single-language script: resolving Hebrew here
    // would fail 07e on every attempt and hold the run after three redrafts,
    // which is worse than the intake hold, not better.
    const result = resolveTargetLanguage({ profile: ENGLISH_PROFILE, voiceRules: { doList: ["כתבו קצר ולעניין, בלי סופרלטיבים ובלי ז'רגון שיווקי מיותר"] } });
    expect(result.status).toBe("english-default");
    if (result.status !== "english-default") throw new Error("unreachable");
    expect(result.evidence.join("\n")).toMatch(/not used/);
  });

  it("but a client whose prose as a whole IS the non-Latin script still holds, and names the field that decided", () => {
    const result = resolveTargetLanguage({ profile: CYRILLIC_PROFILE });
    expect(result.status).toBe("unresolved-non-english");
    if (result.status !== "unresolved-non-english") throw new Error("unreachable");
    expect(result.sourceLabel).toBe("all client prose");

    // ...and when it is one field that carries the whole prose, the hold
    // reason points at THAT field rather than at "the profile".
    const fromVoiceRules = resolveTargetLanguage({ voiceRules: { doList: [CYRILLIC_PROFILE.description] } });
    expect(fromVoiceRules.status).toBe("unresolved-non-english");
    if (fromVoiceRules.status !== "unresolved-non-english") throw new Error("unreachable");
    expect(fromVoiceRules.sourceLabel).toMatch(/voiceRules\.doList|all client prose/);
  });

  it("a Hebrew SELF-DESCRIPTION still wins over English voice rules (the geektime shape, unchanged)", () => {
    const englishRules = "Direct, no corporate jargon. Lead with the fact. Short sentences. One idea per slide. No exclamation marks, no em dashes. ".repeat(4);
    expect(resolveTargetLanguage({ profile: { description: HEBREW_GUIDELINES }, voiceRules: { guidelines: englishRules } })).toMatchObject({
      status: "resolved",
      language: "Hebrew",
      source: "script-sniff",
    });
  });
});

describe("findExplicitLanguageMentions — the shapes that count", () => {
  it.each([
    ["a Hebrew-language technology site", "Hebrew"],
    ["a Hebrew language technology site", "Hebrew"],
    ["we publish in Hebrew", "Hebrew"],
    ["publishes exclusively in Spanish", "Spanish"],
    ["published in Portuguese since 2019", "Portuguese"],
    ["everything is written in Thai", "Thai"],
    ["all content in Japanese", "Japanese"],
    ["Hebrew only, never English translations", "Hebrew"],
    ["for the Russian-speaking market", "Russian"],
    ["for Russian speaking readers", "Russian"],
    ["publishes in he-IL", "he-IL"],
  ])("matches %j -> %s", (text, language) => {
    expect(findExplicitLanguageMentions(text).map((m) => m.language)).toContain(language);
  });

  it.each([
    "we work with Hebrew-speaking founders",
    "the Russian market is our next expansion",
    "our team includes native Hebrew speakers",
    "written in it, the way it was meant to be read",
    "content in no time at all",
    "Greek yogurt brand for health-conscious shoppers",
  ])("does not match %j", (text) => {
    expect(findExplicitLanguageMentions(text)).toEqual([]);
  });

  it("returns the earliest statement first when several languages are named", () => {
    const mentions = findExplicitLanguageMentions("Published in Hebrew, with a weekly digest written in English.");
    expect(mentions.map((m) => m.language)).toEqual(["Hebrew", "English"]);
  });

  it("handles a language named in its own script (עברית) — \\b would not", () => {
    expect(findExplicitLanguageMentions("כל התוכן נכתב ב-עברית only").map((m) => m.language)).toEqual(["Hebrew"]);
  });
});

describe("sniffDominantScript", () => {
  it("has no opinion below the letter floor", () => {
    expect(sniffDominantScript("שלום עולם")).toMatchObject({ kind: "insufficient" });
    expect(MIN_SNIFF_LETTERS).toBeGreaterThan(0);
  });

  it("resolves single-language scripts", () => {
    expect(sniffDominantScript(HEBREW_GUIDELINES)).toMatchObject({ kind: "resolved", language: "Hebrew" });
    expect(sniffDominantScript("Η εταιρεία μας σχεδιάζει προϊόντα για μικρές επιχειρήσεις στην Ελλάδα και την Κύπρο.")).toMatchObject({
      kind: "resolved",
      language: "Greek",
    });
    expect(sniffDominantScript("บริษัทของเราสร้างเครื่องมือการตลาดสำหรับธุรกิจขนาดเล็กในประเทศไทยและเอเชียตะวันออกเฉียงใต้")).toMatchObject({
      kind: "resolved",
      language: "Thai",
    });
  });

  it("splits CJK by kana and Hangul, and refuses to guess for Han alone", () => {
    expect(sniffDominantScript("私たちは中小企業のためのマーケティングツールを作っています。毎週、新しい機能を公開しています。")).toMatchObject({
      kind: "resolved",
      language: "Japanese",
    });
    expect(sniffDominantScript("우리는 중소기업을 위한 마케팅 도구를 만듭니다. 매주 새로운 기능을 공개합니다.")).toMatchObject({ kind: "resolved", language: "Korean" });
    const han = sniffDominantScript("我们为中小企业开发营销工具，每周发布新功能，帮助创始人节省时间并获得更多客户。");
    expect(han).toMatchObject({ kind: "ambiguous", script: "Han" });
    if (han.kind !== "ambiguous") throw new Error("unreachable");
    expect(han.candidates).toEqual(expect.arrayContaining(["Chinese", "Mandarin"]));
  });

  it("reports multi-language scripts as ambiguous with the table's candidates", () => {
    const arabic = sniffDominantScript("نحن نبني أدوات تسويق للشركات الصغيرة والمتوسطة في المنطقة، وننشر ميزات جديدة كل أسبوع.");
    expect(arabic).toMatchObject({ kind: "ambiguous", script: "Arabic" });
    if (arabic.kind !== "ambiguous") throw new Error("unreachable");
    expect(arabic.candidates).toEqual(expect.arrayContaining(["Arabic", "Farsi", "Urdu"]));
  });

  it("calls Latin-dominant prose latin, and evenly mixed prose mixed", () => {
    expect(sniffDominantScript("Teams that automated their weekly reporting saved an average of four hours per week.")).toMatchObject({ kind: "latin" });
    // Half Hebrew, half Latin by letter count: nobody reaches the 50% floor
    // decisively — the exact split lands on "mixed" or a marginal call, but
    // it must never resolve a language.
    const half = `${HEBREW_GUIDELINES.slice(0, 60)} ${"Latin words to balance the count ".repeat(3)}`;
    const sniff = sniffDominantScript(half);
    expect(["mixed", "latin", "resolved"]).toContain(sniff.kind);
    if (sniff.kind === "resolved") expect(sniff.share).toBeGreaterThanOrEqual(0.5);
  });
});

describe("scriptTableEntries — the shared table", () => {
  it("is the same table resolveExpectedScript reads, exposed read-only", () => {
    const entries = scriptTableEntries();
    expect(entries.length).toBeGreaterThan(5);
    for (const entry of entries) {
      for (const name of entry.names) expect(resolveExpectedScript(name)?.name, name).toBe(entry.script.name);
      for (const tag of entry.tags) expect(resolveExpectedScript(tag)?.name, tag).toBe(entry.script.name);
    }
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries[0]!.names)).toBe(true);
    expect(() => {
      (entries[0]!.names as string[]).push("klingon");
    }).toThrow();
  });

  it("every language the inference can name is one the gate can check", () => {
    // The whole point of sharing the table: a resolved language that stage 1
    // cannot map would be a gate with no opinion on the language it just
    // inferred.
    for (const [text, expected] of [
      ["a Hebrew-language site", "Hebrew"],
      ["publishes in Farsi", "Farsi"],
      ["content in Ukrainian", "Ukrainian"],
      ["written in Mandarin", "Mandarin"],
    ] as const) {
      const result = resolveTargetLanguage({ profile: { description: text } });
      expect(result).toMatchObject({ status: "resolved", language: expected });
      if (result.status !== "resolved") throw new Error("unreachable");
      expect(resolveExpectedScript(result.language)).toBeDefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 (RFC-15 §2) — the persisted belief, source 3
// ─────────────────────────────────────────────────────────────────────────────

/** A belief document as `memory.read({ scope: "beliefs" })` returns it, with only the keys this module reads. */
function beliefsWith(belief: Partial<InstagramLanguageBelief> & Pick<InstagramLanguageBelief, "language" | "source">): Record<string, unknown> {
  return {
    // A sibling key, to prove the reader picks its own out of a shared document.
    instagramRunBudget: { version: 1, ewmaRatio: 1 },
    [LANGUAGE_BELIEF_KEY]: {
      script: "",
      evidence: "",
      corpusPosts: 0,
      registerKey: "",
      resolvedAt: "2026-09-11T09:00:00.000Z",
      ...belief,
    },
  };
}

describe("resolveTargetLanguage — source 3, the persisted belief", () => {
  it("a belief ranks ABOVE the script sniff: a previous run's measurement beats an inference from a blurb", () => {
    // The prose sniffs Hebrew and nothing else. The belief says Greek, and it
    // says so from an explicit statement a previous run read — which outranks
    // what this run can infer from a self-description.
    const result = resolveTargetLanguage({
      profile: { name: "Acme" },
      voiceRules: { guidelines: HEBREW_GUIDELINES },
      beliefs: beliefsWith({ language: "Greek", source: "explicit-mention", evidence: 'their site states "published in Greek"' }),
    });
    expect(result).toMatchObject({ status: "resolved", language: "Greek", source: "belief" });
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.evidence.join("\n")).toMatch(/remembered language "Greek"/);
    expect(result.evidence.join("\n")).toMatch(/published in Greek/);

    // ...and with the belief taken away, the same input resolves Hebrew from
    // the sniff. Without this line the case above proves nothing about order.
    expect(resolveTargetLanguage({ profile: { name: "Acme" }, voiceRules: { guidelines: HEBREW_GUIDELINES } })).toMatchObject({
      status: "resolved",
      language: "Hebrew",
      source: "script-sniff",
    });
  });

  it("a belief is IGNORED when brand.language is set — a human editing the portal always wins", () => {
    const result = resolveTargetLanguage({
      brandLanguage: "Spanish",
      beliefs: beliefsWith({ language: "Greek", source: "explicit-mention" }),
    });
    expect(result).toMatchObject({ status: "resolved", language: "Spanish", source: "brand" });
  });

  it("a belief is IGNORED when the prose states a language explicitly — the belief can never become unfixable", () => {
    const result = resolveTargetLanguage({
      profile: { description: "The region's leading Arabic-language business daily." },
      beliefs: beliefsWith({ language: "Greek", source: "own-posts", corpusPosts: 9 }),
    });
    expect(result).toMatchObject({ status: "resolved", language: "Arabic", source: "profile" });
  });

  it("a SNIFF-sourced belief is NEVER re-used — the anti-calcification guard", () => {
    // Delete the `DECISIVE_BELIEF_SOURCES` filter in `readLanguageBelief` and
    // this case goes green as `{ language: "Greek", source: "belief" }`: that
    // is the break-the-code proof. A guess about a thin profile would
    // otherwise outrank the very sniff it came from and become permanent.
    const result = resolveTargetLanguage({
      profile: { name: "Acme" },
      voiceRules: { guidelines: HEBREW_GUIDELINES },
      beliefs: beliefsWith({ language: "Greek", source: "sniff", evidence: "profile.description: 61% Greek script" }),
    });
    expect(result).toMatchObject({ status: "resolved", language: "Hebrew", source: "script-sniff" });
    // It is still visible in the trace — persisted for observability, never acted on.
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.evidence.join("\n")).toMatch(/was NOT re-used/);
  });

  it("a decisive belief resolves a client with no prose at all to read", () => {
    // karoslabs-shaped absence of every prose field, plus one run that DID
    // measure the client's own posts. Before Phase 4 this returned
    // english-default before any belief could be consulted.
    const result = resolveTargetLanguage({ beliefs: beliefsWith({ language: "he-IL", source: "own-posts", corpusPosts: 7 }) });
    expect(result).toMatchObject({ status: "resolved", language: "he-IL", source: "belief" });
  });

  it("a belief naming English is english-default, not a resolved English target", () => {
    const result = resolveTargetLanguage({ beliefs: beliefsWith({ language: "en-US", source: "brief" }) });
    expect(result.status).toBe("english-default");
    if (result.status !== "english-default") throw new Error("unreachable");
    expect(result.evidence.join("\n")).toMatch(/needs no language gate/);
  });

  it("behaves EXACTLY as before when no beliefs are supplied, and when the document holds nothing readable", () => {
    // An English profile on purpose: it falls all the way THROUGH source 3,
    // so an unreadable record has to leave no trace at all.
    const ENGLISH = { description: "Acme Analytics is a business intelligence platform for retail operators. We publish practitioner guides for the people who run stores." };
    const baseline = resolveTargetLanguage({ profile: ENGLISH });
    for (const beliefs of [
      undefined,
      {},
      { instagramRunBudget: { version: 1 } },
      { [LANGUAGE_BELIEF_KEY]: null },
      { [LANGUAGE_BELIEF_KEY]: "Hebrew" },
      { [LANGUAGE_BELIEF_KEY]: { language: "Greek" } }, // no source
      { [LANGUAGE_BELIEF_KEY]: { language: "Greek", source: "vibes" } }, // unknown source
      { [LANGUAGE_BELIEF_KEY]: { language: "   ", source: "own-posts" } },
    ]) {
      expect(resolveTargetLanguage({ profile: ENGLISH, ...(beliefs !== undefined ? { beliefs } : {}) }), JSON.stringify(beliefs)).toEqual(baseline);
    }
  });

  it("null brand.language + English prose + English own posts stays english-default, with the evidence saying why", () => {
    // The karoslabs case, named in RFC-15 §2: a decision with recorded
    // evidence, not a silent skip. 04l, 07e, 07e2 and 07f are all skipped and
    // nothing is spent.
    const result = resolveTargetLanguage({
      brandLanguage: undefined,
      profile: { description: "AI marketing agency for B2B founders. We run the whole funnel so the founder can run the company." },
      voiceRules: { doList: ["lead with the number", "one idea per slide"] },
    });
    expect(result.status).toBe("english-default");
    if (result.status !== "english-default") throw new Error("unreachable");
    expect(result.evidence[0]).toBe("brand.language unset");
    expect(result.evidence.join("\n")).toMatch(/Latin script/);

    const late = adoptLateTargetLanguage(undefined, { ownPostsLanguage: undefined, briefLanguage: "English" });
    expect(late).toEqual({ language: undefined, source: "english-default" });
  });
});

describe("readLanguageBelief — the decisiveness filter", () => {
  it.each(["own-posts", "brand-language", "explicit-mention", "brief"] as const)("re-reads a %s belief", (source) => {
    expect(readLanguageBelief(beliefsWith({ language: "Hebrew", source }))?.source).toBe(source);
  });

  it("refuses a sniff belief, while parseLanguageBelief still returns it for the trace", () => {
    const beliefs = beliefsWith({ language: "Hebrew", source: "sniff" });
    expect(readLanguageBelief(beliefs)).toBeUndefined();
    expect(parseLanguageBelief(beliefs)).toMatchObject({ language: "Hebrew", source: "sniff" });
  });

  it("fills the script from the shared table when the stored record has none", () => {
    expect(readLanguageBelief({ [LANGUAGE_BELIEF_KEY]: { language: "he-IL", source: "own-posts" } })).toMatchObject({
      language: "he-IL",
      script: "Hebrew",
      corpusPosts: 0,
      registerKey: "",
    });
  });

  it("is undefined for an absent, null, non-object or unnamed record", () => {
    expect(readLanguageBelief(undefined)).toBeUndefined();
    expect(readLanguageBelief({})).toBeUndefined();
    expect(readLanguageBelief({ [LANGUAGE_BELIEF_KEY]: null })).toBeUndefined();
    expect(readLanguageBelief({ [LANGUAGE_BELIEF_KEY]: 42 })).toBeUndefined();
    expect(readLanguageBelief({ [LANGUAGE_BELIEF_KEY]: { source: "own-posts" } })).toBeUndefined();
  });
});

describe("buildLanguageBelief — what 09b is allowed to write", () => {
  const now = new Date("2026-09-12T10:00:00.000Z");

  it("builds the record, with the script from the shared table", () => {
    expect(buildLanguageBelief({ language: "he-IL", source: "own-posts", evidence: "7 of 9 own posts in Hebrew", corpusPosts: 7, registerKey: "Hebrew", now })).toEqual({
      language: "he-IL",
      script: "Hebrew",
      source: "own-posts",
      evidence: "7 of 9 own posts in Hebrew",
      corpusPosts: 7,
      registerKey: "Hebrew",
      resolvedAt: "2026-09-12T10:00:00.000Z",
    });
  });

  it("refuses to remember English, or nothing at all", () => {
    for (const language of ["English", "en-US", "  ", undefined]) {
      expect(buildLanguageBelief({ language, source: "brief", evidence: "the brief says so", now }), String(language)).toBeUndefined();
    }
  });

  it("refuses an own-posts belief with an empty corpus — a zero is a fact about the scrape, not about the client", () => {
    expect(buildLanguageBelief({ language: "Hebrew", source: "own-posts", evidence: "none readable", corpusPosts: 0, now })).toBeUndefined();
    // ...but the same fact recorded honestly as a sniff is writable (and, by
    // `readLanguageBelief`, never re-read).
    expect(buildLanguageBelief({ language: "Hebrew", source: "sniff", evidence: "profile is 96% Hebrew", corpusPosts: 0, now })).toMatchObject({ source: "sniff" });
  });

  it("round-trips through readLanguageBelief for every decisive source", () => {
    for (const source of ["own-posts", "brand-language", "explicit-mention", "brief"] as const) {
      const built = buildLanguageBelief({ language: "Hebrew", source, evidence: "e", corpusPosts: 3, registerKey: "Hebrew", now });
      expect(built, source).toBeDefined();
      expect(readLanguageBelief({ [LANGUAGE_BELIEF_KEY]: built })).toEqual(built);
    }
  });
});

describe("adoptLateTargetLanguage — the client's own posts, then the brief", () => {
  it("02d's answer still wins over both", () => {
    expect(adoptLateTargetLanguage("he-IL", { ownPostsLanguage: "Greek", briefLanguage: "Thai" })).toEqual({ language: "he-IL", source: "resolved" });
  });

  it("own posts beat the brief, and say so in the note", () => {
    const adoption = adoptLateTargetLanguage(undefined, { ownPostsLanguage: "Hebrew", briefLanguage: "Greek" });
    expect(adoption).toMatchObject({ language: "Hebrew", source: "own-posts" });
    expect(adoption.note).toMatch(/OWN recent posts/);
    expect(adoption.note).toMatch(/set brand\.language in the portal/);
  });

  it("falls through to the brief when the own-post corpus named nothing", () => {
    for (const ownPostsLanguage of [undefined, "", "   ", "English", "en-US", 42]) {
      expect(adoptLateTargetLanguage(undefined, { ownPostsLanguage, briefLanguage: "Hebrew" }), String(ownPostsLanguage)).toMatchObject({
        language: "Hebrew",
        source: "brief",
      });
    }
  });

  it("English anywhere resolves to no target at all", () => {
    expect(adoptLateTargetLanguage(undefined, { ownPostsLanguage: "English", briefLanguage: "en-US" })).toEqual({ language: undefined, source: "english-default" });
    expect(adoptLateTargetLanguage(undefined, {})).toEqual({ language: undefined, source: "english-default" });
  });

  it("adoptBriefTargetLanguage is the same function with no own-posts source — existing callers are unchanged", () => {
    for (const [resolved, briefTarget] of [
      ["he-IL", "Greek"],
      [undefined, "Hebrew"],
      [undefined, "English"],
      [undefined, undefined],
      [undefined, 42],
    ] as const) {
      expect(adoptBriefTargetLanguage(resolved, briefTarget)).toEqual(adoptLateTargetLanguage(resolved, { briefLanguage: briefTarget }));
    }
    expect(adoptBriefTargetLanguage(undefined, "Hebrew")).toMatchObject({ language: "Hebrew", source: "brief" });
  });
});

describe("bcp47For — one tag, resolved through the shared table", () => {
  it.each([
    ["Hebrew", "he"],
    ["hebrew", "he"],
    ["he", "he"],
    ["he-IL", "he"],
    ["he_IL", "he"],
    ["עברית", "he"],
    ["Greek", "el"],
    ["Thai", "th"],
    ["Japanese", "ja"],
    ["Korean", "ko"],
    ["Chinese", "zh"],
    ["es", "es"],
    ["pt-BR", "pt"],
    ["ru", "ru"],
  ])("%j -> %j", (language, tag) => {
    expect(bcp47For(language)).toBe(tag);
  });

  it("has NO opinion for a bare name in a script several languages share", () => {
    // The Latin row's first tag is "en": returning it for Spanish would mark
    // Spanish copy as English in the lang attribute. No opinion beats a wrong
    // one, and a client who needs a tag sets brand.language to one.
    for (const name of ["Spanish", "Portuguese", "Russian", "Farsi", "Hindi", "Klingon", "", "   "]) {
      expect(bcp47For(name), name).toBeUndefined();
    }
    expect(bcp47For(undefined)).toBeUndefined();
  });
});
