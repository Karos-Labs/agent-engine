# SCRUM-386 — agent-engine's validation gate has no ESLint step to run

**Ticket:** SCRUM-386 · **Repo:** agent-engine · **Status:** decision doc, no production code
changed. **Decision:** option 1 — drop the eslint step from the gate, `typecheck && test` is the
real gate. Confirmed by the product owner (Karos Labs) 2026-09-01.

## The defect

Every batch guide in this programme, up through Batch 9, told implementers to run `npx eslint .`
as part of agent-engine's validation gate. **There is no ESLint in this repo** — no
`eslint.config.*`/`.eslintrc*` outside `node_modules`, no `eslint` entry in any `package.json`, no
`lint` script. `npx eslint .` fetches a transient copy and exits on the missing config. The gate
step named in every batch guide has never once been runnable, for the whole life of this
programme. The repo's own `package.json` script, `"verify": "npm run typecheck && npm test"`,
already says what the real gate is — it just wasn't what the batch guides said.

## Why it's worth a ticket rather than a one-line fix nobody notices

A gate step that cannot run is a gate step everyone learns to skip on their own judgment, and that
habit doesn't stay confined to the one broken step. Eleven independent implementer agents across
this programme (Batches 1+4 through 9) each hit this, each worked around it, and each had to
decide alone that skipping it was acceptable — exactly the kind of silent norm-drift a validation
gate exists to prevent. The fix that actually matters here isn't a code change; it's making the
correction official so nobody has to re-derive it per ticket.

## The decision

**Option 1: drop the eslint step from agent-engine's gate template; state `typecheck && test` IS
the gate, matching what `verify` already does.** Not option 2 (add a real ESLint config,
dependency, and `lint` script wired into `verify`) — that's a separate, larger decision about rule
strictness on a large existing codebase, and adopting a linter mid-programme across a repo this
size would produce a diff nobody could meaningfully review in one pass. Option 1 is a
correction measured in minutes; option 2 is real, future-facing work, scoped below rather than
folded into this ticket.

This was already the de facto practice: every `EXEC-CONTEXT.md` this programme has written since
Batch 5 (Batches 5, 6, 7, 9, and 10's own `EXEC-CONTEXT-ENGINE.md`) already told implementers
explicitly not to run ESLint in agent-engine, and to run it only in karosCMO (which really does
have `eslint.config.mjs`). This decision doc makes that correction official and permanent rather
than something re-derived by whoever writes the next batch guide.

## What changes, concretely

- **Every future batch guide's validation section**, for agent-engine, should read:
  ```bash
  npx tsc --noEmit
  npx vitest run   # or npm test / npm run verify, which runs both
  ```
  with no `npx eslint .` line — this matches this repo's own `verify` script exactly and requires
  no repo code change to become true.
- **For karosCMO**, the eslint step stays, unchanged — that repo has a real, working
  `eslint.config.mjs` and the step has always been runnable there.
- **This decision doc** is the permanent record. Any future batch guide author (human or agent)
  who is unsure whether agent-engine has ESLint should be pointed here rather than re-discovering
  the same gap.

## If option 2 is ever wanted — scoped as its own future ticket, not started here

A real ESLint setup for agent-engine is worth doing on its own merits (catching real classes of
bugs `tsc`+tests don't), but it is a different-shaped ticket than this one, with its own real
decision to make before any code is written:

- **Strictness question, unresolved and out of scope here:** adopt a strict, opinionated config
  (e.g. `typescript-eslint`'s `strict`/`stylistic` presets, matching karosCMO's own
  `eslint.config.mjs`) and accept a large one-time cleanup diff across ~40 workspace packages
  before the gate can go green; or start from a minimal, mostly-off config (unused-vars,
  no-floating-promises, a handful of correctness rules) that passes on today's code with near-zero
  diff, and tighten it incrementally later. This programme's own experience with karosCMO's real
  config (10 pre-existing warnings tolerated indefinitely rather than fixed) suggests the minimal
  starting point is the lower-risk default, but that's a recommendation for whoever picks this up,
  not a decision made here.
- **Scope, once strictness is picked:** add `eslint` + `@typescript-eslint` + a config file at the
  repo root; a `lint` script; wire it into `npm run verify`; decide whether it runs per-workspace
  or once at the root (this repo's `tsc`/`vitest` gates both run from the root, so root-level is
  the likely default, but workspace-scoped configs may be needed given how large and varied this
  monorepo's packages are).
- **Do not fold this into SCRUM-386.** This ticket's own framing says as much: *"either is better
  than a gate nobody can execute,"* and only option 1 is available without a strictness decision
  first.

## Summary for whoever reads this next

| Question | Answer |
|---|---|
| Does agent-engine have ESLint today? | No — confirmed by absence of any config file, `package.json` entry, or `lint` script. |
| Was the batch guides' `npx eslint .` step ever runnable? | No, for the entire life of this programme. |
| What's the real gate? | `npx tsc --noEmit` + `npx vitest run` (`npm run verify`), which the repo's own `package.json` already states. |
| Does karosCMO keep its eslint step? | Yes, unchanged — it has a real, working `eslint.config.mjs`. |
| Is a real ESLint setup for agent-engine wanted? | Possibly, but it's a separate, larger ticket with its own strictness decision — not started here. |
| Does SCRUM-386 change any production code? | No. |
