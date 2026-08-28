/**
 * Hand-written types for `vitest-source-resolution.mjs`.
 *
 * The `.mjs` stays plain JavaScript for the same reason `workspace-graph.mjs`
 * does — it has to run with no build step — but the 39 `vitest.config.ts`
 * files that import it ARE covered by the root `tsc --noEmit`
 * (`include: ["packages/**\/*.ts", …]` matches `vitest.config.ts`), so the
 * import needs a declaration or the typecheck fails.
 */
export interface WorkspaceSourceAlias {
  readonly find: RegExp;
  readonly replacement: string;
}

export declare function workspaceSourceAliases(): WorkspaceSourceAlias[];
