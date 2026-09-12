import { describe, expect, it } from "vitest";
import {
  FEW_SHOT_FOR_JUDGE,
  FEW_SHOT_FOR_WRITER,
  LANGUAGE_REGISTER_PACKS,
  MIN_EXEMPLAR_CHARS,
  UNIVERSAL_PACK_KEY,
  buildLanguageBrief,
  buildPersona,
  judgeFewShot,
  publicationName,
  registerPackFor,
  renderLanguageBrief,
  type LanguageBriefBrief,
  type OwnPostEntry,
} from "../src/workflow/language-register.js";
import { resolveExpectedScript } from "../src/workflow/language-gate.js";

/**
 * Instagram Phase 4 (RFC-15 §3): `04l-language-register`'s payload — the
 * persona, the three-layer register card, the term policy and the few-shot
 * drawn from the client's OWN posts.
 *
 * Pure, model-free, network-free. Nothing here is Chromium-gated, so every
 * case in this file runs on every machine.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Four real-shaped Hebrew trade-press captions, each comfortably over
 * `MIN_EXEMPLAR_CHARS`. Two of them open with a verb form the pack
 * recognises (`הודיעה`, `כתבו`) and two do not, so `verbOpeningShare` has
 * something to be strictly between 0 and 1 about. They carry Latin tokens
 * (`inference`, `API`) because that is what Hebrew tech copy does, and the
 * term policy has to pick them up.
 */
const HEBREW_POSTS: readonly string[] = [
  "אנבידיה הציגה אתמול שבב חדש שמיועד להרצת מודלים גדולים בענן, והמחיר שלו גבוה משמעותית מהדור הקודם. בדקנו מה זה אומר לסטארטאפים שמריצים inference בעצמם ומה האלטרנטיבות שנשארו להם השנה.",
  "שלוש שנים אחרי ההשקה, הפלטפורמה עדיין לא הצליחה לגייס מפתחים מחוץ לישראל. דיברנו עם ארבעה מייסדים שניסו לעבוד איתה, והם מסבירים למה ה-API עצמו הוא הבעיה האמיתית ולא השיווק.",
  "הודיעה החברה על גיוס של 40 מיליון דולר בסבב B בהובלת קרן אמריקאית. מה שמעניין בעסקה הוא לא הסכום אלא השווי: הוא נשאר זהה לסבב הקודם משנת 2023, וזה מספר שכדאי לשים לב אליו.",
  "כתבו לנו השבוע עשרות מפתחים ששאלו איך בוחרים בין שני שירותי הענן הגדולים כשהתקציב מוגבל. ריכזנו את ההבדלים המרכזיים בעלות, בזמן ההקמה ובתמיכה, עם מספרים אמיתיים משלושה פרויקטים.",
];

/** Six English captions from the same (bilingual) account, each over the exemplar floor. */
const ENGLISH_POSTS: readonly string[] = [
  "The chip announced yesterday is aimed at running large models in the cloud, and it costs a great deal more than the previous generation did at launch.",
  "Three years after launch the platform still has not recruited developers outside its home market, and four founders told us the interface is the reason why.",
  "The company raised forty million dollars in a round led by an American fund, and the valuation is the number worth reading rather than the headline figure.",
  "Dozens of developers wrote in this week asking how to choose between the two big cloud providers when the budget is fixed and the timeline is not.",
  "We pulled the real numbers from three projects and put the differences in cost, setup time and support side by side so you can see them at once.",
  "A weekly reading of what actually shipped, what slipped, and which of last quarter's promises nobody has mentioned since the announcement went out.",
];

function socialPost(excerpt: string, extra: Partial<OwnPostEntry> = {}): OwnPostEntry {
  return { excerpt, channel: "instagram", origin: "social", ...extra };
}

const BRIEF: LanguageBriefBrief = {
  positioning: {
    oneLiner: "Geektime is Israel's largest technology publication.",
    whatWeSell: "Daily reporting on startups, venture capital and the people behind them.",
    differentiators: [],
  },
  icp: { summary: "founders, engineers and investors in Israeli tech", roles: [], pains: [], industries: [], geos: [] },
  language: {},
};

// ─────────────────────────────────────────────────────────────────────────────
// (e) The persona — derived, never invented
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPersona", () => {
  it("renders 'a staff editor at Geektime' from profile.companyName alone — nothing here knows the word Geektime", () => {
    const persona = buildPersona({ profile: { companyName: "Geektime", name: "geektime.co.il" }, brief: BRIEF, mode: "hot-news" });
    expect(persona).toContain("You are a staff editor at Geektime.");
    expect(persona).toContain("You write for founders, engineers and investors in Israeli tech.");
    expect(persona).toContain("read Geektime every week and would put down a post that sounds translated");
  });

  it("falls back profile.companyName -> profile.name -> the brief's positioning subject -> a generic publication", () => {
    expect(publicationName({ companyName: "Geektime", name: "Other" }, BRIEF)).toBe("Geektime");
    expect(publicationName({ name: "Geektime" }, BRIEF)).toBe("Geektime");
    // No profile at all: the subject of "Geektime is Israel's largest..." is
    // the clause before the copula.
    expect(publicationName(undefined, BRIEF)).toBe("Geektime");
    expect(publicationName(undefined, { ...BRIEF, positioning: { ...BRIEF.positioning, oneLiner: "We help teams ship faster than they used to." } })).toBe("this publication");
  });

  it("the role is a fixed per-mode string, and evergreen reads differently from news", () => {
    const news = buildPersona({ profile: { name: "Geektime" }, brief: BRIEF, mode: "hot-news" });
    const evergreen = buildPersona({ profile: { name: "Geektime" }, brief: BRIEF, mode: "deep-value" });
    expect(news).toContain("a staff editor at Geektime");
    expect(evergreen).toContain("the editor who writes the explainers at Geektime");
    expect(news).not.toEqual(evergreen);
    // No mode supplied still produces a persona rather than "undefined at X".
    expect(buildPersona({ profile: { name: "Geektime" }, brief: BRIEF })).toContain("a staff editor at Geektime");
  });

  it("appends brief.language.register VERBATIM, last", () => {
    const register = "Direct and unimpressed. Never a superlative, never an exclamation mark.";
    const persona = buildPersona({ profile: { name: "Geektime" }, brief: { ...BRIEF, language: { register } }, mode: "hot-news" });
    expect(persona.endsWith(register)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (f) Packs — Hebrew first-class, everything else universal-only
// ─────────────────────────────────────────────────────────────────────────────

describe("LANGUAGE_REGISTER_PACKS", () => {
  it("is keyed through resolveExpectedScript, so it can never drift from SCRIPT_TABLE", () => {
    for (const key of Object.keys(LANGUAGE_REGISTER_PACKS)) {
      expect(resolveExpectedScript(key)?.name, key).toBe(key);
    }
  });

  it("Hebrew resolves from every spelling brand.language can hold", () => {
    for (const spelling of ["Hebrew", "hebrew", "he", "he-IL", "עברית"]) {
      expect(registerPackFor(spelling).key, spelling).toBe("Hebrew");
    }
  });

  it("tags ONLY the mechanically certain rows hardFail", () => {
    const pack = registerPackFor("Hebrew");
    const severity = Object.fromEntries(pack.rows.map((r) => [r.key, r.severity]));
    expect(severity["copula"]).toBe("hardFail");
    expect(severity["purisms"]).toBe("hardFail");
    expect(severity["quotationMarks"]).toBe("hardFail");
    expect(severity["digits"]).toBe("hardFail");
    expect(severity["dates"]).toBe("hardFail");
    expect(severity["nikud"]).toBe("hardFail");
    // A calque is an uncertain signal, and the answer to an uncertain signal
    // is no threshold and a judge — never a gate failure.
    expect(severity["calques"]).toBe("softTell");
    expect(severity["hypercorrections"]).toBe("softTell");
    expect(severity["hyphen"]).toBe("softTell");
    expect(severity["registerLevel"]).toBe("softTell");
  });

  it("exports exactly the hardFail terms to gate.nativeLanguage, and no soft ones", () => {
    const { forbiddenTransliterations } = registerPackFor("Hebrew");
    const wrongs = forbiddenTransliterations.map((t) => t.wrong);
    expect(wrongs).toEqual(expect.arrayContaining(["הינו", "יישומון", "מרשתת", "סופטוור", "הארדוור"]));
    // Retag `calques` as hardFail and this line fires: a client writing
    // "בסוף היום" would start failing a deterministic gate over an idiom.
    expect(wrongs).not.toContain("בסוף היום");
    expect(wrongs).not.toContain("אשר");

    // THE PAIR CROSSES THE BOUNDARY, not `wrong` alone. `gate.nativeLanguage`
    // emits `right` verbatim in its hard-fail-4 steer (`Replace "יישומון" with
    // "אפליקציה"`), which is what keeps the phase's "every finding carries a
    // correction" contract on the findings that are free to produce. Flatten
    // this back to `.map((t) => t.wrong)` in `registerPackFor` and it fails.
    expect(forbiddenTransliterations).toEqual(expect.arrayContaining([{ wrong: "יישומון", right: "אפליקציה" }]));
    for (const pair of forbiddenTransliterations) {
      expect(pair.right, pair.wrong).toBeTruthy();
    }
  });

  it("(f) a language with no pack gets the universal rows only, and no invented Hebrew", () => {
    const pack = registerPackFor("Greek");
    expect(pack.key).toBe(UNIVERSAL_PACK_KEY);
    expect(pack.universalOnly).toBe(true);
    expect(pack.language).toBe("Greek");
    expect(pack.rows.map((r) => r.key).sort()).toEqual(["dates", "numerals", "quotationMarks"]);
    // No pack, no opinion: the gate degrades to "nothing to say", never to
    // "fail every draft for this client".
    expect(pack.forbiddenTransliterations).toEqual([]);
    expect(pack.staysInLatin).toEqual([]);
    const rendered = pack.rows.map((r) => r.guidance).join("\n");
    expect(rendered).not.toMatch(/\p{Script=Hebrew}/u);
    expect(rendered).toMatch(/gate\.lintPost bans en dashes/);
  });

  it("a language the shared table has never heard of also degrades to universal, never to a guess", () => {
    const pack = registerPackFor("Klingon");
    expect(pack.key).toBe(UNIVERSAL_PACK_KEY);
    expect(pack.language).toBe("Klingon");
    expect(pack.forbiddenTransliterations).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Few-shot selection
// ─────────────────────────────────────────────────────────────────────────────

describe("buildLanguageBrief — the few-shot corpus", () => {
  it("(c) a bilingual account of 10 posts, 4 Hebrew and 6 English, yields exactly 4 in-script exemplars", () => {
    // Disable the per-post `sniffDominantScript` filter and this returns six
    // exemplars, most of them English — the plan's failure mode dressed as
    // its fix. That is the break-the-code proof for this case.
    const ownPosts = [...HEBREW_POSTS, ...ENGLISH_POSTS].map((p) => socialPost(p));
    const brief = buildLanguageBrief({ language: "Hebrew", brief: BRIEF, ownPosts, profile: { companyName: "Geektime" } });
    expect(brief).toBeDefined();
    if (!brief) throw new Error("unreachable");

    expect(brief.fewShot).toHaveLength(4);
    expect(brief.corpusPosts).toBe(4);
    for (const post of brief.fewShot) {
      expect(post.text).toMatch(/\p{Script=Hebrew}/u);
      expect(ENGLISH_POSTS).not.toContain(post.text);
    }
    // Four of six is short, so the note says so with the counts rather than
    // letting a reader assume the corpus was full.
    expect(brief.corpusNote).toMatch(/only 4 Hebrew posts/);
    expect(brief.corpusNote).toMatch(/10 posts returned, 4 in-script/);
  });

  it("reads only the client's OWN posts — a ledger entry is our drafting, not their voice", () => {
    const ownPosts = [...HEBREW_POSTS.map((p) => socialPost(p)), { excerpt: HEBREW_POSTS[0]!, channel: "instagram-agent", origin: "ledger" }];
    const brief = buildLanguageBrief({ language: "Hebrew", brief: BRIEF, ownPosts });
    expect(brief?.fewShot).toHaveLength(4);
  });

  it("drops an excerpt under the exemplar floor — a three-word caption teaches no register", () => {
    const short = "טכנולוגיה ישראלית, כל יום, בלי רעש שיווקי מיותר ובלי סופרלטיבים";
    expect(short.length).toBeLessThan(MIN_EXEMPLAR_CHARS);
    const brief = buildLanguageBrief({ language: "Hebrew", brief: BRIEF, ownPosts: [...HEBREW_POSTS.map((p) => socialPost(p)), socialPost(short)] });
    expect(brief?.fewShot).toHaveLength(4);
    expect(brief?.fewShot.some((p) => p.text === short)).toBe(false);
  });

  it("ranks engagement first, then prose length", () => {
    const ownPosts = [
      socialPost(HEBREW_POSTS[0]!, { engagement: { likes: 2, comments: 0 } }),
      socialPost(HEBREW_POSTS[1]!, { engagement: { likes: 900, comments: 40 } }),
      socialPost(HEBREW_POSTS[2]!),
      socialPost(HEBREW_POSTS[3]!),
    ];
    const brief = buildLanguageBrief({ language: "Hebrew", brief: BRIEF, ownPosts });
    expect(brief?.fewShot[0]?.text).toBe(HEBREW_POSTS[1]);
    expect(brief?.fewShot[1]?.text).toBe(HEBREW_POSTS[0]);
  });

  it("caps the writer at six exemplars and hands the judge the first four of the same posts", () => {
    const many = Array.from({ length: 9 }, (_, i) => socialPost(`${HEBREW_POSTS[i % 4]!} וגם מספר ${i} בסוף המשפט הזה.`));
    const brief = buildLanguageBrief({ language: "Hebrew", brief: BRIEF, ownPosts: many });
    expect(brief?.fewShot).toHaveLength(FEW_SHOT_FOR_WRITER);
    expect(brief?.corpusPosts).toBe(9);
    expect(brief?.corpusNote).toBeUndefined();
    expect(judgeFewShot(brief!)).toEqual(brief!.fewShot.slice(0, FEW_SHOT_FOR_JUDGE));
  });

  it("(d) an empty corpus gives a corpusNote and an empty few-shot, and the brief still carries the persona and the pack", () => {
    // `research.socialHistory` drops textless posts silently and caches the
    // empty result, so zero posts is a fact about the scrape. It must never
    // read as "this client has no Hebrew", and nothing may hold.
    const brief = buildLanguageBrief({ language: "Hebrew", brief: BRIEF, ownPosts: [], profile: { companyName: "Geektime" }, socialAccounts: 2, mode: "hot-news" });
    expect(brief).toBeDefined();
    if (!brief) throw new Error("unreachable");

    expect(brief.fewShot).toEqual([]);
    expect(brief.corpusPosts).toBe(0);
    expect(brief.corpusNote).toBe("no Hebrew posts were readable for this client's own accounts (2 accounts, 0 posts returned, 0 in-script, 0 at least 120 characters)");
    expect(brief.persona).toContain("a staff editor at Geektime");
    expect(brief.conventions.key).toBe("Hebrew");
    expect(brief.register.pack.rows.length).toBeGreaterThan(5);
    expect(brief.register.measured).toBeUndefined();
    expect(brief.terms.forbiddenTransliterations.map((t) => t.wrong)).toContain("הינו");
    // The few-shot block is OMITTED ENTIRELY rather than rendered empty.
    const rendered = renderLanguageBrief(brief);
    expect(rendered).not.toMatch(/things this client actually published/);
    expect(rendered).toMatch(/Corpus note: no Hebrew posts were readable/);
  });

  it("an all-English corpus for a Hebrew client is an empty corpus, and says how many came back", () => {
    const brief = buildLanguageBrief({ language: "Hebrew", brief: BRIEF, ownPosts: ENGLISH_POSTS.map((p) => socialPost(p)), socialAccounts: 1 });
    expect(brief?.fewShot).toEqual([]);
    expect(brief?.corpusNote).toBe("no Hebrew posts were readable for this client's own accounts (1 account, 6 posts returned, 0 in-script, 0 at least 120 characters)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The measured layer and the term policy
// ─────────────────────────────────────────────────────────────────────────────

describe("buildLanguageBrief — the measured register", () => {
  const brief = buildLanguageBrief({ language: "he-IL", brief: BRIEF, ownPosts: HEBREW_POSTS.map((p) => socialPost(p)), profile: { companyName: "Geektime" } });

  it("measures over the WHOLE in-script set, not just the exemplars", () => {
    expect(brief?.register.measured?.posts).toBe(4);
    expect(brief?.register.measured?.meanSentenceWords).toBeGreaterThan(5);
    expect(brief?.register.measured?.meanCaptionChars).toBeGreaterThan(MIN_EXEMPLAR_CHARS);
    expect(brief?.register.measured?.emojiPerPost).toBe(0);
    expect(brief?.register.measured?.hashtagsPerPost).toBe(0);
  });

  it("reports the verb-opening share as a lower bound, strictly between 0 and 1 for this corpus", () => {
    // Two of the four posts open with a form the pack recognises (הודיעה,
    // כתבו) and the other sentences do not. A detector that matched nothing
    // would report 0; one that matched everything would report 1.
    const share = brief?.register.measured?.verbOpeningShare;
    expect(share).toBeDefined();
    expect(share!).toBeGreaterThan(0);
    expect(share!).toBeLessThan(1);
  });

  it("counts first/second person without counting את, the accusative particle", () => {
    const person = brief?.register.measured?.personPer100Words;
    expect(person).toBeDefined();
    // "כתבו לנו" is the only first-person marker in the corpus; counting את
    // would put this in double figures.
    expect(person!).toBeGreaterThan(0);
    expect(person!).toBeLessThan(5);
  });

  it("says nothing it cannot measure: a universal pack reports no verb or pronoun statistics", () => {
    const greek = buildLanguageBrief({
      language: "Greek",
      brief: BRIEF,
      ownPosts: [
        socialPost("Η εταιρεία ανακοίνωσε χθες ένα νέο τσιπ για μεγάλα μοντέλα στο σύννεφο, και το κόστος του είναι πολύ υψηλότερο από την προηγούμενη γενιά που κυκλοφόρησε."),
      ],
    });
    expect(greek?.register.measured?.posts).toBe(1);
    expect(greek?.register.measured?.verbOpeningShare).toBeUndefined();
    expect(greek?.register.measured?.personPer100Words).toBeUndefined();
    expect(greek?.register.rendered).not.toMatch(/open with a verb/);
  });

  it("renders all three layers, most specific first", () => {
    const withRegister = buildLanguageBrief({
      language: "Hebrew",
      brief: { ...BRIEF, language: { register: "Direct and unimpressed." } },
      ownPosts: HEBREW_POSTS.map((p) => socialPost(p)),
    });
    const rendered = withRegister!.register.rendered;
    expect(rendered.indexOf("MEASURED on 4")).toBeGreaterThanOrEqual(0);
    expect(rendered.indexOf("MEASURED on 4")).toBeLessThan(rendered.indexOf("CONVENTIONS for Hebrew"));
    expect(rendered.indexOf("CONVENTIONS for Hebrew")).toBeLessThan(rendered.indexOf("THE CLIENT'S OWN STATED REGISTER"));
    expect(rendered).toContain("Direct and unimpressed.");
  });
});

describe("buildLanguageBrief — the term policy", () => {
  it("unions the pack's stays-in-Latin list with every Latin token in the client's own in-script posts", () => {
    const brief = buildLanguageBrief({ language: "Hebrew", brief: BRIEF, ownPosts: HEBREW_POSTS.map((p) => socialPost(p)) });
    const terms = brief!.terms.allowedLatinTerms;
    // From the pack.
    expect(terms).toContain("AI");
    expect(terms).toContain("SaaS");
    // From this client's own Hebrew posts, which is the half a generic list
    // can never have: `gate.nativeLanguage` must not flag a term the client
    // themselves leaves in English.
    expect(terms).toContain("inference");
    expect(terms).toContain("API");
    // Case-deduped: "API" is in both and appears once.
    expect(terms.filter((t) => t.toLowerCase() === "api")).toHaveLength(1);
  });

  it("takes no Latin terms from posts that were filtered out for being in the wrong script", () => {
    const brief = buildLanguageBrief({ language: "Hebrew", brief: BRIEF, ownPosts: ENGLISH_POSTS.map((p) => socialPost(p)) });
    // The English corpus contributes nothing; only the pack's own list survives.
    expect(brief!.terms.allowedLatinTerms).toEqual([...registerPackFor("Hebrew").staysInLatin]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The envelope
// ─────────────────────────────────────────────────────────────────────────────

describe("buildLanguageBrief — script, direction and tag", () => {
  it("carries the target verbatim, the script from the shared table, rtl and the bcp47 tag", () => {
    const brief = buildLanguageBrief({ language: "he-IL", brief: BRIEF, ownPosts: HEBREW_POSTS.map((p) => socialPost(p)) });
    expect(brief).toMatchObject({ target: "he-IL", script: "Hebrew", direction: "rtl", bcp47: "he" });
  });

  it("is ltr for a Latin-script target, and omits the tag rather than guessing one", () => {
    const brief = buildLanguageBrief({ language: "Spanish", brief: BRIEF, ownPosts: [] });
    expect(brief).toMatchObject({ target: "Spanish", script: "Latin", direction: "ltr" });
    expect(brief?.bcp47).toBeUndefined();
  });

  it("is undefined for no target and for English — 04l does not run, and nothing is spent", () => {
    for (const language of [undefined, "", "   ", "English", "english", "en", "en-US"]) {
      expect(buildLanguageBrief({ language, brief: BRIEF, ownPosts: HEBREW_POSTS.map((p) => socialPost(p)) }), String(language)).toBeUndefined();
    }
  });

  it("renders the few-shot under an instruction that cannot be read as a topic list", () => {
    const brief = buildLanguageBrief({ language: "Hebrew", brief: BRIEF, ownPosts: HEBREW_POSTS.map((p) => socialPost(p)) });
    const rendered = renderLanguageBrief(brief!);
    expect(rendered).toContain("Four things this client actually published, in their own Hebrew.");
    expect(rendered).toMatch(/This is how they SOUND/);
    expect(rendered).toMatch(/It is NOT a topic list/);
    expect(rendered).toContain(brief!.persona);
  });
});
