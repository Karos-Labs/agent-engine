# agents/

RFC-02 territory. One folder per concrete agent (e.g. `x-agent/`,
`linkedin-agent/`), each a small class extending `BaseAgent` from
`@agent-engine/core`, plus its own workflow definition and tool needs.

Empty until RFC-01's Phase 1 (tool layer + BaseAgent) is done and the first
agent migration starts — see `docs/RFC-02-agent-migration.md`.
