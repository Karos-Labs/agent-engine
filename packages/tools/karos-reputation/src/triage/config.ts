import { triageConfigData } from "./triage-config.data.js";
import type { TriageConfig } from "./types.js";

/** The verbatim-ported product-default triage rubric (`triage-config.json`). Per `references/scoring.md`: this file states the product defaults; a client's frozen `02-config.json` is the runtime authority once one exists — callers may pass a different `TriageConfig` to `triage()`, this is only the shared default. */
export const DEFAULT_TRIAGE_CONFIG = triageConfigData as unknown as TriageConfig;
