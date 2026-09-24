/**
 * EVERY PLACE AN AGENT MAY END A RUN WITH NOTHING, AND WHY THAT IS HONEST.
 *
 * The owner's ruling of 2026-09-17: *an agent never ends a run with no
 * deliverable* — fall back, redact, warn or annotate, but always deliver. It
 * is a rule the code states in a dozen doc comments and nothing checked, which
 * is how four gates were still answering a human's "no" by throwing away a
 * finished landing page, a measured SEO report, a drafted reputation pulse and
 * a five-channel campaign bundle (PR #231, 2026-09-24).
 *
 * So this is the register, and `hold-manifest.test.ts` is the enforcer: every
 * `throw new WorkflowHeld(...)` in every agent workflow must appear here with
 * a sentence saying why nothing exists to deliver at that line — and every
 * entry here must still match a real site, so the list cannot rot into a
 * description of a program that no longer exists.
 *
 * ## `stage` is the question worth asking
 *
 * `before-work` is the honest hold: the run has produced nothing yet, because
 * it has nothing to produce from — no subject it may write about, no readable
 * source, no footage, no thread worth answering. Ending there costs the client
 * an explanation, which is the correct deliverable for "there was nothing to
 * make".
 *
 * `after-work` is the one that needs a second look: something exists by the
 * time this fires, so the hold throws work away. Every entry carrying it also
 * carries what a fix would deliver instead. One is left, and it is listed with
 * what it would take.
 *
 * ## How a site is identified
 *
 * By a distinctive substring of the message it throws, never by a line number:
 * these files are 14,000 lines and every insertion above would otherwise
 * invalidate the register. The guard strips comments before matching, so a
 * doc comment quoting `throw new WorkflowHeld(...)` — several do, describing
 * the holds that were REMOVED — is not mistaken for a hold.
 */

export interface HoldSite {
  /** A distinctive substring of the thrown message. */
  match: string;
  /** Why ending the run with nothing is the honest answer here. */
  why: string;
  stage: "before-work" | "after-work";
  /** For an `after-work` hold: what delivering instead would look like. */
  ifFixed?: string;
}

export const HOLD_MANIFEST: Record<string, HoldSite[]> = {
  "blog-agent": [],

  "branded-shorts-agent": [
    {
      match: "touches a never-topic the client set",
      why: "the takeaway the run was asked to edit toward is on the client's never-list, and nothing was edited in its place — there is no short here, only a request the client's own rules forbid.",
      stage: "before-work",
    },
    {
      match: "client brand assets failed video.assetsCheck",
      why: "a branded short is the client's own brand assets applied to footage; without usable assets there is nothing to brand it with, and the check runs before any frame is cut.",
      stage: "before-work",
    },
    {
      match: "no usable spoken words after cropping",
      why: "the whole product is a cut of what somebody said. No speech, no cut — and this fires before any clip is rendered.",
      stage: "before-work",
    },
    {
      match: "style exploration did not clear its own output validation",
      why: "the exploration IS the deliverable of that workflow, and an unparseable exploration has produced no candidates to show.",
      stage: "before-work",
    },
  ],

  "campaign-orchestrator": [
    {
      match: "strategy plan did not clear its own validation",
      why: "the plan is what every channel slot is built from; without one there are no slots to run and nothing has been drafted.",
      stage: "before-work",
    },
    {
      match: "reused slotId",
      why: "two slots claiming one id means nothing honestly cleared selection — the fan-out has not run, so no channel has produced anything.",
      stage: "before-work",
    },
    {
      match: "no channel produced a deliverable for this campaign",
      why: "this is the definition of nothing to deliver: every channel ran and none of them cleared its own gates.",
      stage: "before-work",
    },
  ],

  "instagram-agent": [
    {
      match: "touches a never-topic the client set",
      why: "the run was told to post about something the client forbids, and the topic override is the only subject it had — nothing was drafted in its place.",
      stage: "before-work",
    },
    {
      match: "no subject available for this run",
      why: "the catalog served no lane, no subject was requested and discovery proposed none: there is nothing to write about, before a word is written.",
      stage: "before-work",
    },
    {
      match: "the extraction step resolved to",
      why: "no fetched document yielded a readable source, so every claim a post could make would be unsourced. The run holds before drafting rather than publishing invention.",
      stage: "before-work",
    },
    {
      match: "no drafting attempt produced copy that cleared its own schema",
      why: "every attempt came back unparseable, so there is no copy — not a poor post, no post. The attempts are on the trace for whoever looks.",
      stage: "before-work",
    },
  ],

  "linkedin-agent": [
    {
      match: "every available topic is on the client's never-list",
      why: "there is nothing this account is permitted to post about this run, which is a fact about the client's own rules rather than a failure of the draft.",
      stage: "before-work",
    },
  ],

  "newsletter-agent": [],

  "reddit-agent": [
    {
      match: "doesn't look like a real reddit.com thread URL",
      why: "the run was pointed at something that is not a thread; there is no conversation to reply to and nothing has been drafted.",
      stage: "before-work",
    },
    {
      match: "the requested thread touches a never-topic",
      why: "the thread is on the client's never-list. A person has to decide it, and no reply was written.",
      stage: "before-work",
    },
    {
      match: "no fresh threads found",
      why: "discovery found nothing recent enough to answer — the run has no subject, and reddit is a reply product.",
      stage: "before-work",
    },
    {
      match: "the thread scout found nothing worth replying to",
      why: "the scout's whole job is to say whether anything deserves a reply this run; a pass is its answer, not a failure to produce one.",
      stage: "before-work",
    },
    {
      match: "twice named a thread that was not among the candidates",
      why: "nothing honestly cleared selection, so the run has no thread and therefore no reply.",
      stage: "before-work",
    },
    {
      match: "was already answered in a prior run",
      why: "one reply per thread per client is a hard product rule; answering twice is the outcome the hold exists to prevent, and no second reply was drafted.",
      stage: "before-work",
    },
    {
      match: "subreddit eligibility check failed",
      why: "the community's own rules refuse the reply this run would write, and the check runs before drafting.",
      stage: "before-work",
    },
  ],

  "seo-geo-agent": [
    {
      match: "prompt set rejected",
      why: "the reviewer refused the prompt set BEFORE any capture ran, so the report does not exist yet — this is the one gate in this agent where holding discards nothing.",
      stage: "before-work",
    },
    {
      match: "fix drafting did not clear its own output validation",
      why: "the fix drafts came back unparseable, so the agent-direct half of the report has nothing in it — which is not the same as the report having nothing in it, and that is the problem below.",
      stage: "after-work",
      ifFixed:
        "by this line the run has paid for a technical crawl, an AI-visibility capture, a scoring pass and the recommendation firing, and a human has approved generating fixes. The report could ship with its measurements and recommendations and no drafted fixes, recording the failure as a `contentRepair` — the treatment the rejection at step 12 already has. Needs a fixture that drives one bounded agent to `content_fail` without the fake router throwing first.",
    },
  ],

  "tiktok-agent": [
    {
      match: "touches a never-topic the client set",
      why: "the requested topic is forbidden by the client's own rules and nothing was drafted in its place.",
      stage: "before-work",
    },
    {
      match: "candidate to make and nothing to widen to",
      why: "no lane, no attached footage, no proposable subject: there is no clip to make, decided before any footage is fetched.",
      stage: "before-work",
    },
    {
      match: "no source footage from any tier",
      why: "a short is footage. Every tier was tried and named in the message, and none supplied any.",
      stage: "before-work",
    },
    {
      match: "the attached footage has no spoken words",
      why: "there is neither speech to cut nor a topic to write over it — the two ways this agent can make a short, both absent.",
      stage: "before-work",
    },
    {
      match: "moment selection did not clear its own output validation",
      why: "no legal clip exists in the transcript and the selection came back unparseable, so there is no moment to cut.",
      stage: "before-work",
    },
    {
      match: "is not clippable",
      why: "the chosen moment cannot be cut and no run of whole sentences is a legal clip either — the source cannot yield a short.",
      stage: "before-work",
    },
    {
      match: "the script writer returned nothing schema-valid",
      why: "no script, and no grounded brief or typed direction to build one from: there is nothing to say over the footage.",
      stage: "before-work",
    },
  ],

  "x-agent": [
    {
      match: "every available topic is on the client's never-list",
      why: "nothing this account may post about this run, which is the client's own rule rather than a drafting failure.",
      stage: "before-work",
    },
    {
      match: "engagement lane daily cap reached",
      why: "the cap is a deliberate product limit on how often this lane posts; the run stops before drafting rather than writing a post it may not publish.",
      stage: "before-work",
    },
  ],
};
