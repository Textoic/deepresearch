# architecture.md

The one place in this repository for prose about the code. Code carries **no comments**
(see `AGENTS.md`); every decision, trade-off, and finding lives here. Keep entries short
and factual, and update the relevant section in the same change that alters the behaviour
it describes.

## Shape of the pipeline

```
cli.ts → ResearchClient.runResearch
           ├── gatherEvidence   → source-adapters, search/searxng, evidence (selection)
           ├── resolveDecomposition → market-decomposition (per-unit dossiers)
           ├── arenaContext     → arena, evidence-brief
           ├── writeReport      → report-prompt (messages) → provider → citations
           └── assemble         → run-assembly, decomposition-render, senate-report
                                  → storage/file-store
```

Every module is pure except the adapters (`providers/`, `search/`, `storage/`,
`polymarket.ts`, `source-adapters.ts`, `senate-evidence.ts`), which own all I/O.

## Module responsibilities

| Module | Owns |
| --- | --- |
| `research-client.ts` | Run orchestration and the budget/stop-reason lifecycle. |
| `run-assembly.ts` | Pure assembly of a run's report from its parts; policy validation. |
| `report-prompt.ts` | Writer prompt construction and evidence excerpting. |
| `evidence.ts` | Cutoff eligibility, canonicalisation, deduplication. |
| `market-policy.ts` | Anti-anchoring policy text and the target-odds sentence filter. |
| `market-units.ts` | What gets researched: unit planning, queries, plan parsing. |
| `market-decomposition.ts` | The component-research loop (`MarketDecomposer`). |
| `decomposition-session.ts` | Shared budgeted-inference and evidence-ledger base class. |
| `decomposition-prompts.ts` | Component prompt text and message builders. |
| `decomposition-render.ts` | Dossier synthesis context and appendix rendering. |
| `arena.ts` / `evidence-brief.ts` | Leaderboard extraction and per-lab date evidence. |
| `senate-evidence.ts` / `senate-report.ts` | Underlying race quotes and roster; their rendering. |

## Decisions and invariants

### Evidence

- URL canonicalisation preserves semantic query parameters; only fragments and known
  tracking parameters (`utm_*`, `fbclid`, `gclid`) are stripped.
- Eligibility is applied **before** deduplication, so an ineligible duplicate cannot
  displace valid evidence. Within a URL, a fetched page outranks a snippet.
- Search snippets are discovery/claim evidence, never an automatic semantic verdict; the
  report must label the limitation. A blocked or challenge page falls back to its snippet
  and records `retrievalError` rather than failing the run.
- Observation dates are not publication dates. Revision and processing lag are unknown, so
  a current snapshot cannot establish what was known at a past cutoff (PortWatch, Pyth).

### Budget

- `BudgetGuard` enforces the hard cost cap outside model prompts; the model is never asked
  to respect a budget. A provider may return an unexpected bill: the actual amount is
  recorded and made visible rather than clamped.

### Market policy

- Raw prices and excluded markets stay in the audit snapshot only, never in writer
  metadata. Target-market URLs contribute frozen, price-free resolution metadata.
- The sentence filter in `market-policy.ts` is conservative and complements — never
  replaces — the semantic prompt policy. It is not a guarantee against every paraphrase of
  target odds. Its per-event rules live in `TARGET_LEAK_RULES`, one entry per event shape.

### Arena extraction

- Unknown layouts fail closed. A row that does not parse ends extraction rather than being
  skipped, because skipping would let a non-contiguous set be published as "the top 20".
  Fewer than 20 validated contiguous rows publishes no table at all.
- Date-only evidence cannot establish intraday ordering, so `compareBoardDate` returns
  `same_day` rather than an order.
- A board data date after the cutoff withdraws the rows entirely.
- `evidence-brief.ts` skips aggregated changelogs and category indexes (`release-notes`,
  `/migration/`, `/news`): their first date need not date any announcement. Each lab gets a
  small bounded evidence budget, preferring fetched pages over snippets.

### Decomposition

- `CLASS_II_2026` plus the two separately identified special elections is a **research
  checklist**, not evidence that an election remains scheduled or that any party will win.
- Discovery runs even when the live roster looks comprehensive, and never infers a missing
  candidate from summed prices.
- Inference is sequential to avoid GPU contention on local providers; the two independent
  searches per unit run concurrently.
- A second discovery pass runs after the last listed candidate: sources gathered for listed
  candidates routinely name people absent from the initial broad searches. Units appended
  there are researched by the same loop, which is why `researchUnits` iterates by index.
- Dossier condensation cuts on whole lines so citation links are never severed mid-URL.

### Evaluation

- The rubric is human-reviewed, weighted, and atomic; it deliberately does not prescribe a
  golden report. Phrase matching is a transparent baseline that semantic judges can be
  layered on later.
- A blank or interrupted generation scores zero: it must not earn quality points for having
  cost nothing.

### Storage

- Each run directory is self-contained (run, report, ledger, event, retrieval, evidence,
  prompt, optional decomposition/dossiers) so runs are easy to archive and diff.

## Enforced limits

`tools/lint.mjs` (TypeScript compiler API, no dependencies) fails on any comment and on
functions past complexity 8, 40 lines, nesting depth 3, or 4 parameters, and on files past
220 lines. `tools/lint-hook.mjs` runs it as a `PostToolUse` hook from `.claude/settings.json`
after every agent edit, and `npm test` runs it before the type-check. Limits change only on
explicit human instruction.

## Findings from the 2026-09-07 complexity audit

Behaviour was preserved throughout; all 46 tests pass unchanged except for import paths.

- `runResearch` (complexity 58, 96 lines) became a pipeline of `gatherEvidence`,
  `resolveDecomposition`, `arenaContext`, `writeReport`, `assemble`, with prompt building
  moved to `report-prompt.ts` and pure assembly to `run-assembly.ts`.
- `decomposeMarket` (complexity 50, 121 lines) became `MarketDecomposer` over
  `DecompositionSession`, with prompts, unit planning, and rendering in sibling modules.
- `fetchRaceOdds` (32), `parseCliArgs` (29), `extractArenaSnapshot` (20), `selectEvidence`
  (19), `toSource` (19), `renderSenateReport` (16) were decomposed into named predicates
  and lookup tables (`TARGET_LEAK_RULES`, `SCENARIOS`, `PROVIDERS`, option validators).
- One real defect removed: `runResearch` pushed the identical `Search failed: <query>`
  limitation twice per failed search (once building the list, once again a few lines
  later). It is now emitted once. Tests assert with `.some(...)`, so nothing depended on
  the duplicate.
- `renderSenateReport` took an `event` argument for its scenario table that it never used;
  the helper now takes only the roster.
- Magic numbers that had to be read twice to interpret (excerpt budgets, retry token
  counts, timeouts, seat counts) are now named constants at the top of their module.
