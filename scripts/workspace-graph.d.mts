/**
 * Hand-written types for `workspace-graph.mjs`.
 *
 * The module itself stays plain JavaScript — its own header explains why: it
 * "runs before anything is compiled, including inside the Docker builder
 * stage". It gained TypeScript callers with AU54 (`vitest-source-resolution.mjs`
 * is JS, but the 39 `vitest.config.ts` files and
 * `packages/workflow/__tests__/source-resolution.test.ts` are TS and are
 * covered by the root `tsc --noEmit`), so the shape is declared here rather
 * than duplicated.
 */
export interface WorkspaceNode {
  /** Absolute path to the package directory. */
  readonly dir: string;
  /** Internal (`@agent-engine/*`) dependency names, from both dep sections. */
  readonly deps: readonly string[];
  /** Whether the package declares its own `build` script. */
  readonly buildable: boolean;
}

export declare const REPO_ROOT: string;

export declare function readJson(file: string): unknown;

export declare function workspaceDirs(): string[];

export declare function loadGraph(): Map<string, WorkspaceNode>;

export declare function topoSort(graph: Map<string, WorkspaceNode>): string[];

export declare function buildOrder(graph?: Map<string, WorkspaceNode>): string[];
