import type { ProposedAction, TriageConfig } from "./types.js";

/**
 * `proposed_action` (triage.py): proposal-first doctrine (playbook §2, Ines
 * 2026-07-31) — every FLAG carries the action we propose, never bare
 * homework. Deterministic: first matching rule in config order wins;
 * `already_responded` overrides (a public answer already exists); `default`
 * catches everything else.
 */
export function proposedAction(signals: readonly string[], respondBlocked: boolean, cfg: TriageConfig): ProposedAction {
  const paCfg = cfg.proposed_actions;
  if (respondBlocked) {
    return { id: "already-responded", action: paCfg.already_responded };
  }
  for (const rule of paCfg.rules) {
    const exact = rule.when_any_signal ?? [];
    const prefixes = rule.when_any_signal_prefix ?? [];
    for (const sig of signals) {
      if (exact.includes(sig) || prefixes.some((p) => sig.startsWith(p))) {
        return { id: rule.id, action: rule.action };
      }
    }
  }
  return { id: "default", action: paCfg.default };
}
