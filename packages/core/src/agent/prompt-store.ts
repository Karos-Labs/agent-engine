/**
 * A managed, versioned store for craft-policy/system-prompt content (RFC-01
 * §16.1): `BaseAgent`'s `skillRef` resolves to `promptId@version` through
 * this interface rather than a hardcoded string literal embedded in a
 * deployment script. Concrete backends (Firestore-backed `promptVersions`
 * collection, Vertex AI's prompt management surface) implement this same
 * shape — swap the adapter, not the call site.
 */
export interface PromptStore {
  /** Resolves a prompt's content. `version` omitted means "this store's own notion of latest". */
  getPrompt(promptId: string, version?: string): Promise<string>;
}

export interface SkillRefParts {
  promptId: string;
  version?: string;
}

/** Parses `skillRef` as `promptId@version` (RFC-01 §16.1) — `version` is absent when `skillRef` names only an id. */
export function parseSkillRef(skillRef: string): SkillRefParts {
  const at = skillRef.indexOf("@");
  if (at === -1) {
    return { promptId: skillRef };
  }
  return { promptId: skillRef.slice(0, at), version: skillRef.slice(at + 1) };
}

/**
 * An in-memory `PromptStore` — for local development and unit tests. Not
 * durable, not shared across processes; a real deployment points
 * `BaseAgentRuntime.promptStore` at a Firestore- or Vertex-backed
 * implementation instead (RFC-01 §16.1).
 */
export class InMemoryPromptStore implements PromptStore {
  private readonly versions = new Map<string, Map<string, string>>();
  private readonly latestVersion = new Map<string, string>();

  /** Registers one version of a prompt. The most recently set version becomes "latest" for that `promptId`. */
  setPrompt(promptId: string, version: string, content: string): void {
    let versionMap = this.versions.get(promptId);
    if (!versionMap) {
      versionMap = new Map();
      this.versions.set(promptId, versionMap);
    }
    versionMap.set(version, content);
    this.latestVersion.set(promptId, version);
  }

  async getPrompt(promptId: string, version?: string): Promise<string> {
    const versionMap = this.versions.get(promptId);
    if (!versionMap) {
      throw new Error(`InMemoryPromptStore: no prompt registered for id "${promptId}"`);
    }

    const resolvedVersion = version ?? this.latestVersion.get(promptId);
    if (!resolvedVersion) {
      throw new Error(`InMemoryPromptStore: no version available for prompt "${promptId}"`);
    }

    const content = versionMap.get(resolvedVersion);
    if (content === undefined) {
      throw new Error(`InMemoryPromptStore: no version "${resolvedVersion}" registered for prompt "${promptId}"`);
    }
    return content;
  }
}
