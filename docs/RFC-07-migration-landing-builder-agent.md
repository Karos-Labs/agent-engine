# RFC-07: Migrating Landing Builder (product s6, Website Redesign)

**Depends on:** RFC-01 (engine core), RFC-02 (migration recipe, §2)
**Source material (read directly this session):** `karos-agents/products/live/landing-page/{ENGINE-SPEC.md,LANDING-PAGE-PRODUCT.md,landing-builder/SKILL.md,engine/{AGENT-INVOCATION.md,gate.mjs,FEEDBACK.md,README.md,INTAKE-REQUEST.md},docs/LANDING-PORT-PENDING.md}`, plus `karos-agents/catalog/products-catalog.json`'s `s6` entry, plus `karos-agents/products/live/landing-page/website-redesign/SKILL.md` and `LANDING-PAGE-PRODUCT.md` (headers only, to identify the older skill — not read in full).
**Not registered in `customAgents` or Dynamic Agent Studio:** neither `landing-builder` nor its older sibling `website-redesign` has a `register-*.ts` script in `karosCMO/scripts/` — confirmed by the full scripts listing used across this whole session. Both exist only as `products-catalog.json` "menu" entries and karos-agents skills; **see §2 before assuming either is the live implementation.**

---

## 1. Read this one differently — it is already specified as an agent, not a script

Every other product migrated in this set describes itself as a skill a human or a cron invokes. Landing Builder's own `engine/AGENT-INVOCATION.md` says the opposite outright: *"The engine is an agent run, not a function call... 'Execute' fires a Claude agent (Agent SDK / Claude Code headless) that follows the landing-builder skill against one client's input bundle, using engine/template/ and engine/gate.mjs as tools, and emits a standalone Next.js site. Budget for LLM API cost + minutes of latency per run — it is not a sub-second deterministic call."* This is the closest thing in the karos-agents catalogue to a hand-written preview of RFC-01's `BaseAgent`: an input bundle, a bounded tool set (template copy, gate script, Playwright), a JSON result contract (`result.json` with `status`/`assumptions`/`preview`), and an explicit escalation path (`needs_human`). The migration work here is less "redesign this as an agent" and more "port a design that already assumed agent-engine's shape, onto agent-engine."

## 2. The load-bearing finding: the product catalog's "s6" points at a different, older engine than the one this RFC is about

`products-catalog.json`'s `s6` ("Website Redesign") lists `skill_id: "karos-website-redesign"` for both its steps, pointing at `products/live/landing-page/website-redesign/SKILL.md` — **not** at `landing-builder/`. Reading that older skill's own product index (`LANDING-PAGE-PRODUCT.md`) shows a materially different architecture: a multi-vendor-skill pipeline (`brand-to-css` → **N candidate design directions** sharing one copy set → a `karos-brand-compliance` gate → build each direction → a CRO pass via `page-cro`/`copywriting`/`copy-chief` → a Nielsen/UX-rethink/WCAG audit rendered via **Claude Preview MCP** at three breakpoints → **the client picks 1 of N** → a GEO/SEO readiness gate). Landing Builder's own `ENGINE-SPEC.md` §2 lists exactly this shape ("3/4 escalating versions," a best-of-N pattern, an external MCP component) among the things it **deliberately scrapped**, replacing it with one deterministic output per client. These are not two names for the same thing — they are two competing implementations of the same catalog product, and the catalog currently points at the one Landing Builder was built to replace.

**This is the same class of bug as RFC-02 §8's "committed-skill-vs-deployed-prompt drift," but one level up: not a stale prompt inside one agent, but a stale pointer to an entirely different agent for the same product.** Do not resolve this silently during migration. It is a real product decision — replace `s6`'s registration to point at the new engine, run both behind a flag while the new one proves out, or keep both as genuinely distinct offerings — and it should go to whoever owns the s6 product line (the same "flag, don't guess" posture used for RFC-04's Daniel/Ines-gated decisions and RFC-05's score/grade discrepancy).

## 3. A second, smaller finding: a stale "port pending" doc that reads as a live blocker but probably is not

`docs/LANDING-PORT-PENDING.md` (dated 2026-06-30) says the engine "ported cleanly" from a feature branch but that the skills need four more files — `ENGINE-SPEC.md`, `engine/gate.mjs`, `engine/FEEDBACK.md`, `engine/fixtures/forge/` — before they are "operational," and lists a `git checkout origin/landing-page-agent -- ...` re-extract command. A direct directory listing this session shows **all four of those already exist** under `products/live/landing-page/` on the current branch. Most likely this gap was closed by the "2026-06-30 reorg sweep" note at the top of the same file and the doc was simply never deleted. **Verify this before treating it as a real blocker** — it reads like one at first glance, and would send an implementer down a re-extraction path that appears to already be unnecessary.

## 4. The pipeline, and why it is closer to a coding agent than a writing agent

| Phase | What it does | RFC-01 shape |
|---|---|---|
| 0. INTAKE | Read the old site, brand guidelines, context docs, and the SEO/GEO baseline from `outputs/seo-geo/` (a real, useful cross-reference to RFC-04's output — confirm the read path once RFC-04 lands). Build the `carryForward[]` inventory (working tools + "professional elements" like a partner-logo strip). | bounded agent step, code-assisted (file reads) |
| 1. REFERENCE | The 9 craft-floor sites set *quality*, never *look* — client guidelines are LAW. | bounded step; mostly a precedence rule, not much model work |
| 2. COPY | Raw intake facts → on-brand copy obeying `brandLaw`/`voice`, written into a typed `LandingContent` object. | bounded agent step, schema-out |
| 3. COMPOSE | Choose sections from a fixed taxonomy — included only if intake supplies content. Content-driven, not template-forced. | bounded agent step |
| 4. MAKE | **Copy the FORGE template tree, then edit exactly four things**: CSS tokens, three `next/font/google` families, the content file, and any carry-forward/bespoke components. This is literal file read/write/edit — a coding-agent task. | agent step with **file-write tools scoped to one client's output directory** |
| 5. GATE | `gate.mjs` (deterministic: token drift, font fidelity, brand lint, structure, optional `next build`) + Playwright render checks (200, @390/@1280, no overflow, no near-black opener, console clean) + **one craft-verdict judgment pass** (client guidelines → 9-site floor → "not boring" bar → first-pass bar). On fail: one targeted fix, re-check. No tournament. | code gate + one bounded judgment step — RFC-01 §5.6's self-correction gate, already specified almost verbatim |
| 6. OUTPUT | A standalone, independently deployable Next.js site per client. | artifact handoff |

Phase 4 is the reason this migration is unlike the other seven: the agent is **writing and editing real source files in a real directory tree** and then **running `next build`/Playwright against them**, not producing text or a scored JSON blob. This is exactly the scenario RFC-01 §5.5's tool-sandboxing design (Claude Agent SDK subagent-per-slot isolation + a write-fence hook) was written for, and it has the clearest real justification of any agent in this set: the agent must be structurally prevented from writing outside `OUTPUT_PATH/site` or editing the read-only `engine/template/` kit, not merely instructed not to.

## 5. Two design choices this product already got right, worth porting as-is rather than re-deriving

- **The gradual-autonomy rollout the product spec already states:** *"First ~5-7 clients: route every result through human review before deploy regardless of status... After that, auto-deploy `status: ok` and queue `needs_human`."* This is RFC-01's evals-gated-rollout idea (§12), independently arrived at and already scoped to a concrete client count. Reuse this number and mechanism rather than inventing a new rollout policy for this agent.
- **The durable-state-as-reproducibility-anchor pattern:** `brand.json` + `src/content/<slug>.ts` + the section manifest are committed per client, so a feedback rebuild (`MODE=rebuild`) is "a re-run with a feedback delta applied," never hand-patched edits. This is the same shape as RFC-01 §8.4a's durable step store, just git-committed-files today instead of Firestore-backed. Preserve the principle (state is data, not conversation history) even if the storage substrate changes.

## 6. What is explicitly a stub — do not build it now

**Media sourcing option C** (programmatic stock-photo sourcing or AI generation for missing media slots) is explicitly marked in both `ENGINE-SPEC.md` §13 and `AGENT-INVOCATION.md` §6 as *"FUTURE — a STUB, not built or wired into the engine yet; do not rely on it."* Until then the order is client-supplied asset (A) then on-brand placeholder (B), recorded in the assumptions list. Do not build C as part of this migration; it would be scope the product itself has explicitly deferred.

## 7. Tools needed

- New: `landing.copyTemplate` (copies `engine/template/` into a client's output path), a scoped file-write tool for phase 4 (bounded to `OUTPUT_PATH/site`, enforced by a write-fence hook per RFC-01 §5.5 — not by convention), `landing.gate` (wraps `gate.mjs`), `landing.renderCheck` (the Playwright battery), `landing.craftVerdict` (likely a bounded agent step rather than a tool, since it is a judgment call against the guidelines/craft-floor/first-pass bar).
- Reuse: `client.*` for brand guidelines/intake, `research.pull`-style read for the old-site capture, and — once RFC-04 lands — a read of that client's `outputs/seo-geo/` baseline per §4 phase 0.

## 8. Portal integration — resolve §2 before registering anything

Do not register a `customAgents`/Dynamic Agent Studio spec for `landing-builder` under a fresh key without first resolving the `s6` conflict in §2. Two honest paths, either acceptable, neither to be picked silently: (a) migrate `landing-builder` as the new implementation **of** `s6`, updating the catalog's `skill_id` and deprecating `website-redesign`, once the new engine has cleared its own bar (§5's first-5-7-clients human review); or (b) register it as a distinct new product alongside `s6` if the two are meant to coexist for different client segments. Whichever is chosen, the decision — and who made it — belongs in this document's history, not inferred from which registration script happened to get written first.

## 9. Definition of done

Per RFC-02 §7, with these additions: (1) the FORGE fixture reproduces its blessed screenshots (`_qa/forge-*.png`) through the ported pipeline before any real client runs; (2) the ported `gate.mjs` passes on FORGE with the exact same verdict shape; (3) the §2 catalog conflict is resolved by the s6 product owner, not silently decided by this migration; (4) the §3 stale-doc question is confirmed (the four "pending" files already exist — verify nothing else from that doc is still genuinely missing); (5) one real client site clears the objective floor, the carry-forward completeness check, and the craft verdict, under human review, before this is called live in Agent Studio.
