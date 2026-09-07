# AGENTS.md

Rules for any AI agent working in this repository. They are enforced mechanically by
`node tools/lint.mjs`, which runs automatically after every file edit.

## 1. No comments in code

Source and test files contain **zero comments**. No `//`, no `/* */`, no JSDoc, no
banner blocks, no `TODO`, no commented-out code. The linter fails on any comment.

Rationale, trade-offs, findings, and non-obvious constraints go in **`architecture.md`**
— the only place in this repository where prose about the code belongs. If you feel the
urge to explain something in a comment, do one of two things instead:

1. Rename the symbol or extract a named function so the code states the fact itself.
2. Add or update the relevant section of `architecture.md`.

Read `architecture.md` before changing anything, and update it in the same change when
you alter a documented behaviour, invariant, or trade-off. Keep entries short and factual.

## 2. Complexity limits

Enforced per function by the linter (`tools/lint.mjs`, `LIMITS`):

| Rule | Limit |
| --- | --- |
| `max-complexity` (cyclomatic) | 8 |
| `max-function-lines` | 40 |
| `max-nesting-depth` | 3 |
| `max-parameters` | 4 |
| `max-file-lines` | 220 |

When you exceed one, restructure — never loosen the limit. The limits in
`tools/lint.mjs` are changed only on explicit human instruction.

Ways out that are always available:

- Extract a named helper for each branch of a long conditional chain.
- Replace `if`/`else if` ladders and `switch` over constants with a lookup table or a
  registry array of `{ match, handle }` entries.
- Return early instead of nesting; invert conditions to flatten.
- Split a function that both decides and acts into `decide` and `act`.
- Take one options object instead of a long parameter list.
- Split a file that has grown past the line limit along its responsibilities.

## 3. Style

- TypeScript, ESM, `strict` mode, Node ≥ 22, no runtime dependencies.
- Relative imports carry the `.ts` extension.
- Prefer pure functions; keep I/O (`fetch`, `fs`) at the edges in `providers/`,
  `search/`, `storage/`, and the adapter modules.
- Names carry the meaning a comment would have: `isEligibleForResearch`, not `check`.
- No defensive `try`/`catch` that swallows an error silently; either handle it and record
  a diagnostic in the run artefacts, or let it propagate.
- Do not widen public types in `src/types.ts` without updating `architecture.md`.

## 4. Workflow for every change

1. Read `architecture.md` for the area you are touching.
2. Make the change.
3. `node tools/lint.mjs` — must be clean. The post-edit hook runs this for you and will
   report violations back; fix them in the same turn, do not defer them.
4. `npm test` — type-check plus the Node test runner.
5. Update `architecture.md` if a documented decision changed.

Do not add new lint tooling, config files, or dependencies to satisfy these rules. The
linter is deliberately dependency-free and lives in one file.
