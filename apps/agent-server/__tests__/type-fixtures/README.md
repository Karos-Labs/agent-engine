Fixtures for the SCRUM-328 type-enforcement tests in
`../workspace-store-wiring.test.ts`.

They are `.ts.txt`, not `.ts`, on purpose: two of them are SUPPOSED to fail to
compile, so they must stay outside `tsconfig.test.json`'s `include`. The test
copies each into `__tests__/` under a temporary name, runs `tsc` on it, and
asserts the expected exit status.
