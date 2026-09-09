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
| `source-tier.ts` | Provenance classification, attribution detection, evidence-base summary. |
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

### Source provenance

- `sourceTier` used to be hardcoded to 2 for every retrieved page, so it carried no
  information and only `eval.ts` read it. `source-tier.ts` now derives it from the host:
  tier 1 primary/official, tier 2 established newsroom, tier 3 derivative or
  self-published, tier 4 everything unrecognised.
- **Unrecognised hosts default to tier 4, not to the middle.** The 2026-09-07
  press-secretary run drew 191 sources from 126 domains, and its core claim rested on a
  content farm; an unknown domain must read as unverified provenance rather than as
  ordinary reporting. Adding a host to a tier is a deliberate act.
- Host matching checks the exact hostname and its registrable domain, so `uk.reuters.com`
  is tier 2 while `reuters.com.example.test` is tier 4.
- An explicit `sourceTier` on a document wins. Structured adapters (Pyth, PortWatch,
  frozen underlying quotes) set tier 1 themselves and are never reclassified.
- `attributedOrigin` reports the outlet a tier 3/4 page credits ("according to the New
  York Post"). It is a hint for the writer, shown as "original not retrieved", never a
  verdict; a bare match longer than five words is discarded rather than guessed at.
- Provenance is rendered into both the writer prompt and the per-unit dossier prompts, and
  `PROVENANCE_POLICY` states the rule the model must apply: repetition across low-tier
  pages is not corroboration.
- `evidenceBaseSummary` is pushed into the run limitations so the tier mix of the whole
  bundle is visible in the report, not only per source.

### Which sources the synthesis writer sees

- The resolution batch exposed a further selection failure: Cuba's September 7 report of
  stalled talks was retrieved but displaced by older official pages, so synthesis described
  talks as progressing. `prioritySources` reserves space for supplied clarification links
  and up to three newest dated tier-1/2 sources whose titles mention the subject. Remaining
  synthesis slots retain provenance ordering; the ten-source and excerpt budgets do not grow.
  Components also receive these sources from the shared evidence pool, capped at ten sources,
  so initial retrieval evidence is not lost when a component's own searches miss it. This
  title-based freshness heuristic is a coverage safeguard, not semantic relevance validation.

- `synthesisSources` used to take the first six sources by retrieval order. In the
  press-secretary run those six were the first search's aggregator hits, so the synthesis
  never saw `whitehouse.gov` or Axios at all. It now ranks by provenance (tier, then
  fetched page over snippet) and keeps ten.
- Ranking makes array position stop matching citation numbers, so the prompt carries
  `NumberedSource` — the document with its **global** number — instead of relying on
  `index + 1`. Dossier citations and writer citations therefore stay on one numbering.
- Synthesis excerpt terms come from the event title. They were previously a fixed
  Senate-specific word list applied to every market.
- `selectExcerpt` selects whole passages — paragraphs, or sentences within one — instead of
  650-character chunks. Fixed chunks cut mid-word and mid-sentence, and joined the pieces
  with a 20-character `[... excerpt ...]` banner repeated for every gap, which cost tokens
  and read as noise. Non-adjacent passages are now joined by `[…]`. The marker is not
  dropped altogether: splicing passages from different dates into apparently continuous
  prose is precisely the misreading the resolved-claim cross-check exists to catch.
- Ten is close to the ceiling, not a free parameter. `maxInputTokens` is declarative:
  `OllamaProvider` never sends it and pins `num_ctx` to 32768, which input **and** output
  share. The 2026-09-07 Senate synthesis already used 22 280 input tokens against an 8 192
  output allowance; four more excerpted sources cost roughly 1 900 more. Raising
  `SYNTHESIS_SOURCES` or `SYNTHESIS_EXCERPT_CHARACTERS` again needs the synthesis call's
  measured input tokens checked against that window, or Ollama will silently drop the
  front of the prompt — the system prompt — with no error.

### Where the section contract sits

- The required-section list used to end `userPrompt`, which put it about a quarter of the
  way into the message: `annotate` then appended up to 47 000 characters of dossiers plus
  the limitations after it. The last thing the writer read was a list of retrieval caveats,
  and the 2026-09-08 AGI report duplicated a whole dossier section verbatim and stopped
  before "What would change the conclusion", "Limitations" and its conclusion.
- `sectionContract` is therefore appended by `annotate` as the final block, after the
  dossiers and limitations, and carries the rules that failure mode needs: write every
  section including the last, put each fact in exactly one section, organise by the
  question rather than by the order evidence was gathered.
- `annotate` takes one `Annotations` object rather than a fifth positional parameter.

### Budget

- `BudgetGuard` enforces the hard cost cap outside model prompts; the model is never asked
  to respect a budget. A provider may return an unexpected bill: the actual amount is
  recorded and made visible rather than clamped.

### Market policy

- `ResearchMarketRequest.clarification` is optional caller-supplied text. The CLI accepts
  `--clarification` or UTF-8 `--clarification-file` (mutually exclusive). The event snapshot
  stores it separately from Gamma `raw`; discovery, component and synthesis contexts retain
  the full text and supplied order. Dates and authenticity are unverified, explicitly
  disclosed, and must not be inferred for historical replay. An omitted replay value keeps
  the saved clarification; a changed value drops stale component reports and rewrites from
  saved evidence. An empty string explicitly clears it.
- `marketContext` deduplicates complete rule texts and associates each eligible contract
  with a `ruleIndex`; this preserves distinct deadlines without repeating identical rules
  for every outcome and overrunning the model context. Component writers now receive this
  same contract context instead of only the event title.
- `PolymarketMarket.createdAt` is optional and included in contract context for windows
  beginning at market creation; explicit rule dates still take precedence over API dates.
- `RESOLUTION_POLICY` requires necessary conditions, exclusions, source hierarchy, occurrence
  windows and reporting grace periods. It distinguishes formal status from practical power
  and minimum qualifying acts from more demanding real-world endpoints.
- `resolution-research.ts` contains evidence-seeking checklists for the five supplied
  failure cases. These are questions, not asserted current facts or forecast targets. They
  seed two dependency dossiers and four queries per event, avoiding the generic candidate
  workflow for sentence ranges and date labels. Open nested contracts control their own
  timeframes even when the event slug or description retains an expired year.
- The supplied Maduro and four-paragraph NATO clarifications are regression fixtures.
  `reviews/run-resolution-2026-09-08.mjs` generates a reproducible five-market review batch
  with saved evidence, prompts and model calls. Agreement with target prices is not a
  quality criterion; checklist coverage and source support require human review.
- Clarification URLs are fetched directly (up to eight) by `clarification-adapter.ts`,
  because searching the exact Romanian release IDs returned an unrelated ministry page.
  Retrieval failures remain adapter diagnostics; blank fallbacks are not evidence. Eligible
  linked pages reach every component with global source numbers and survive in the snapshot;
  replay performs no link fetch. `mapn.ro`, `presidencia.gob.ve`, `en.mfa.gov.ir` and `commonslibrary.parliament.uk` are
  explicitly classified as official hosts.
- The resolution checklist also reaches synthesis directly: a component may invert a
  conditional exception, so its paraphrase must not displace the original criteria. The
  first NATO draft incorrectly excluded all munitions and invented a 2025 incident year;
  direct releases date the incident August 20, 2026. Unknown intended target is not proof
  of a third-party target. Older evidence cannot establish current absence of a legal act.
- Iran's official-site-only timeline searches returned old treaty material. Its timeline
  queries now include the elapsed negotiating window and recent broader reporting. The
  reviewed contexts in `reviews/resolution-contexts-2026-09-08/` include separately checked
  August evidence; raw generated reports remain distinct from those edited research contexts.
- CLI example: `npm start -- market venezuela-leader-end-of-2026 --provider ollama --model qwen3.8:27b --budget 0 --searxng-url http://127.0.0.1:8080 --effort high --clarification-file reviews/resolution-contexts-2026-09-08/venezuela-clarification.txt`.
- The live regenerated NATO report uses the 2026 incident date and Cuba synthesis includes
  September 7 diplomacy evidence. Two regenerated reports retain citation-integrity flags
  and are `partial`; a clean generation stop is not semantic validation. The edited contexts
  correct identified interpretation errors without overwriting raw output. No downstream
  forecaster or probability-calibration benchmark was run.

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

### Which search engines actually run

- `searxng/settings.yml` used `use_default_settings: true` with no engine list. The
  defaults enable `duckduckgo`, `startpage` and `google cse` for general web search — and
  leave `google` **disabled**. Over the 2026-09-07/08 batches those engines failed 110,
  182 and 44 times respectively (CAPTCHA, a `json.decoder.JSONDecodeError` from a changed
  Startpage response format, and Google's bot detection). Plain `google` failed zero times
  because it was never switched on.
- Startpage's failure is a parser breakage, not throttling: it fires on every query at any
  volume. Brave and Google CSE genuinely rate-limit, with `suspended_time=180`, and recover
  on their own.
- The enabled set is now `google` (primary), `brave`, `yep` and `mojeek`, with `startpage`,
  `duckduckgo`, `google cse` and `bing` off. `bing` is off for **quality**: SearXNG's Bing
  engine answered "karoline leavitt press secretary" with Chinese Zhihu threads. `yep` and
  `mojeek` add breadth; `yep`'s index is stale, so it is not a freshness source.
- Measured over five representative queries, top-6 results: the old default set returned
  **0 results**; the new set returns 22-44 per query at 57% tier 1-2. Ninety unique queries
  against `google` at the pipeline's concurrency completed in 10s with no failures.
- `outgoing.request_timeout` is pinned so one hanging engine cannot stall a query.

### Search providers and their fallbacks

- `page-content.ts` owns everything after a result URL is known: page fetch, challenge
  detection, text extraction and its readability gate (`html-text.ts`), publication date,
  tier classification. `SearxngSearchProvider`
  and `SerperSearchProvider` only translate their own response shape into `SearchHit`, so
  both get identical evidence handling.
- An empty SearXNG result set is retried (`EMPTY_RETRY_DELAYS_MS`) **only when
  `unresponsive_engines` is non-empty** — that distinguishes "the engines are down" from
  "this query genuinely has no matches", so a legitimate empty answer costs no delay. If
  the retries still find every engine unavailable the provider throws, so the run records
  `Search failed:` instead of silently claiming a successful search that found nothing.
- `FallbackSearchProvider` returns the first non-empty answer and only throws when **every**
  provider threw; if any provider answered cleanly with nothing, the answer is nothing.
- Serper reports publication as a human string ("2 days ago"). It is carried as
  `publishedHint`, never as `publishedAt`, and a fetched page's own `article:published_time`
  outranks it. `absoluteFromHint` pins an absolute hint to its wall-clock day via `Date.UTC`
  — `new Date("Sep 3, 2026").toISOString()` yields the 2nd in any timezone east of UTC.
- Serper bills 1 credit for up to 10 results and 2 credits for 11-100, so `billedResults`
  never asks for 11-100 when the caller wanted 10 or fewer.

### Reading a page into prose

- `html-text.ts` replaces a two-regex `stripHtml`. That function truncated the response to
  one megabyte **before** removing `<script>` and `<style>`, so on any page larger than the
  cap the closing tag fell outside the slice, the non-greedy match never fired, and the
  whole CSS or JSON bundle was handed to the writer as evidence. A 2026-09-09 CNN fetch
  produced 387 000 characters of stylesheet; the same page now yields 3 800 characters of
  article text. YouTube leaked `ytInitialData` the same way.
- Tag removal is a single-pass scanner, not a regex. `<[^>]+>` ends a tag at the first `>`
  it sees, including one inside a quoted attribute value: Wikipedia stores wikitext in
  `data-mw='{"parts":[...]}'`, so the tail of that JSON escaped into the body text and its
  code-artifact density (6.6 per 1000 characters) was high enough to look like prose. The
  scanner tracks quote state, so an attribute can contain anything.
- The scanner drops the *content* of `script`, `style`, `noscript`, `svg`, `template` and
  `math` to end-of-input when the closing tag is missing, because a truncated code element
  never contains prose. Layout elements (`nav`, `form`, `footer`, `aside`, `head`, …) are
  dropped only when their closing tag exists: an unterminated `<form>` on
  `whitehouse.gov` would otherwise erase every remaining paragraph on the page.
- Boilerplate is filtered per line: a line survives if it has at least eight words and
  either ends a sentence or is majority lowercase-initial. Navigation soup ("Saudi Arabia
  News The Place The Space Who's Who KSA Today …") is title-case and punctuation-free, so
  it goes; article sentences stay. The filter is skipped entirely below
  `SMALL_DOCUMENT_CHARACTERS`, because a small document has no chrome to remove and the
  filter would eat the whole of a genuinely short page.
- `isReadableProse` gates what may become a `page` source, and it separates *garbage* from
  *short*. It rejects empty text and text whose code-artifact density exceeds
  `MAX_CODE_ARTIFACTS_PER_1000`, always. It applies a minimum length **only** to documents
  over `LARGE_DOCUMENT_CHARACTERS`: 88 KB of arabnews.com HTML yielding 129 characters is a
  failed extraction of a client-rendered page, while 1.5 KB yielding 129 characters is a
  short official notice and load-bearing evidence. A rejected page falls back to its
  discovery snippet, which is short, clean and already labelled as an unverified clue.

### Prediction-market sources are never retrieved

- `excluded-hosts.ts` holds one list of prediction-market and odds-tracker hosts, and both
  search providers drop those hits *before* fetching, filtering ahead of the result slice
  so an excluded hit does not consume one of the caller's `limit` slots. Previously such a
  page was fetched, tiered, numbered and only then blanked by `evidenceForWriter`, which
  spent a retrieval and a source slot to deliver the sentence "[Market UI withheld …]" to
  the writer.
- `evidenceForWriter` keeps that redaction as a backstop, now over the same shared list, for
  caller-supplied sources, clarification links and adapter output, none of which pass
  through a search provider.

### The resolved-claim cross-check

- The AWS run is the failure this exists for: an AWS Health page describing an incident that
  opened on 20 October 2025 carried no explicit closure metadata, the writer read it as an
  active event dated 8 September 2026, and the forecaster — reasoning correctly from that
  evidence — returned 99.99% on a contract trading at 50%.
- `market-coherence.ts` turns Gamma's `outcomePrices` into a **binary** signal: which open
  contracts are not priced at a settled level (`SETTLED_PRICE`). The directive names those
  contracts and instructs the writer to treat evidence that appears to settle one of them as
  a contradiction to resolve — occurrence date versus retrieval date, live page versus
  archived record, this contract's window versus an earlier one — and to say which checks
  the evidence passed.
- **No number reaches the model.** This is deliberate and is the reason the check is a list
  of contract names rather than a price. Prices in the writer's context would violate
  `MARKET_RESEARCH_POLICY`, would risk appearing in the report, and would silently
  contaminate a caller that runs its forecaster without a market prior: the report is that
  forecaster's context, so a leaked price is a leaked prior. `market-coherence.test.ts`
  asserts the writer prompt contains neither a price nor `outcomePrices`.
- The directive tells the writer to report evidence that survives the checks as it stands.
  A cross-check that suppressed well-supported evidence would trade a false positive for a
  false negative, which is not an improvement.

### A silent retrieval failure must not become a report

- SearXNG answers `200` with `"results": []` when its upstream engines rate-limit it. On
  2026-09-08 the press-secretary market ran 64 searches, every one "complete" with zero
  documents, and the pipeline produced a 97 437-character report with 26 candidate
  dossiers written from **no evidence at all**, marked `complete`.
- `retrievalCollapsed` treats "retrieval was attempted and every search returned nothing
  or failed, and no source survived" as a `no_evidence` run. It is deliberately narrow:
  a single retrieved document, a caller-supplied source, an adapter document, or a replay
  (which does not search) all keep the run researching.
- The gate runs **before** decomposition, so no dossier is written from nothing, and
  `writeReport` returns the fallback without a generation call. `eval.ts` scores such a
  run zero and the CLI exits non-zero.
- Two tests changed with this: a topic run whose searches all fail was asserting
  `complete`, and the high-effort decomposition test drove the pipeline with a search
  provider returning `[]`. Both encoded the defect; they now supply a document.

### Citations the reader can click

- `linkSourceReferences` only rewrites bare `[Source N]`; a model that writes the whole
  markdown link itself was never checked. The evidence-free press-secretary run wrote 19
  citations, **none** matching any retrieved source, with 18 fabricated but plausible URLs
  on `whitehouse.gov`, Politico, Reuters, the New York Times and the Washington Post.
- `unfoundedCitations` compares every authored `[Source N](url)` against the run's sources
  and `auditCitations` records the mismatches, downgrading `complete` or `partial` to
  `partial`. It never upgrades a worse stop reason.
- Matching is deliberately forgiving so it flags fabrication rather than formatting: URLs
  are compared canonicalised (trailing slash, `utm_*`), a stored URL that merely *starts
  with* the written one counts as a match — markdown truncates a URL at its own `)`, as
  Ballotpedia's `..._(June_2_primary)` does — and the URL pattern excludes whitespace so a
  citation cannot match across a newline into the appended dossiers.
- Measured over the five 2026-09-07/08 evidence-backed reports (83 to 506 citations each)
  this flags 0 or 1 per report, the one hit being a genuinely wrong link. On the
  evidence-free report it flags 19 of 19.

### Partial work is not failed work

- A dossier that exhausts its output allowance gets one larger retry. If that also runs
  out, the model's text is kept as an `output_truncated` dossier rather than discarded and
  replaced with "Research incomplete". `TruncatedOutputError` carries the partial content
  out of `DecompositionSession.call` for that purpose.
- `finalStopReason` grades the run instead of failing it wholesale: a hard dossier failure
  is still `error` and an exhausted budget is still `budget_exhausted`, but truncation or
  incomplete discovery alone yields `partial`. The 2026-09-07 press-secretary run was
  marked `error` — and scored 0 by `eval.ts` — because one of twenty-nine dossiers ran
  long, which invalidated a complete 138 KB report.
- `eval.ts` scores a `partial` run with a fixed coverage penalty. Only an unusable run
  (empty, hard error, over budget, no rules) scores zero.

### What the writer is told about the pipeline

- Reports leaked their own machinery: the press-secretary report carried "*Correction: The
  prompt asks to analyze the provided markets*" and listed "Truncated Dossier" under
  Limitations, presenting an internal shortfall to the reader as a research limitation.
- Operational messages are prefixed `Operational: ` and filtered by `writerLimitations`
  before `annotate` passes limitations to the model. They stay in `run.limitations` for
  the operator.
- Dossier status reaches the writer and the appendix as "full coverage" / "partial
  coverage", never as a `StopReason` identifier, and both system prompts forbid mentioning
  the prompt, the pipeline, dossiers, tools, or length limits.

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
