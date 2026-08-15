/**
 * The "git" half of the file+git lab adapter (RFC-01 §9.2): every write
 * *could* be committed for a human-readable audit trail, the same way
 * today's filesystem-as-state approach works. Phase 1 ships the seam and a
 * no-op default — wiring a real `git add -A && git commit` implementation is
 * an adapter swap, not a call-site change, matching the adapter-swap
 * principle used everywhere else in RFC-01 (§8.4, §9.2).
 */
export interface GitCommitter {
  commit(message: string): Promise<void>;
}

export const noopGitCommitter: GitCommitter = {
  async commit() {
    // Phase 1: no-op. A real implementation shells out to git in `rootDir`.
  },
};
