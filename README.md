# budget-researcher

## General research and source adapters

`ResearchClient.researchTopic({ topic, budgetUsd, sources?, sourceUrls?, effort?, evidencePolicy? })`
researches a general question without fetching Polymarket metadata or requiring market
resolution rules. Market research still uses `researchMarket`. Generic prompts no
longer contain Arena-specific lab, launch, or ranking instructions. Nested market
descriptions and deadlines are included when researching a market.

```ts
import { ResearchClient, OllamaProvider, SearxngSearchProvider,
  PythSourceAdapter, PortWatchSourceAdapter } from "budget-researcher";

const client = new ResearchClient({
  provider: new OllamaProvider("your-local-model"),
  searchProvider: new SearxngSearchProvider({ baseUrl: "http://127.0.0.1:8080" }),
  // Optional: configure only the adapters relevant to this research context.
  sourceAdapters: [
    // new PythSourceAdapter({ feedId: exactFeedId, apiKey: process.env.PYTH_API_KEY! }),
    // new PortWatchSourceAdapter({ portId: exactPortId }),
  ],
});
const run = await client.researchTopic({
  topic: "What explains recent changes in shipping through the Strait of Hormuz?",
  sourceUrls: ["https://portwatch.imf.org/"],
  budgetUsd: 0,
  effort: "medium",
});
```

Effort currently controls bounded search coverage: low = 2, medium = 4, high = 6
queries, with up to six results per query. Medium adds recent developments and
counterevidence; high adds historical data and methodology/alternative explanations.
Explicit queries replace these defaults (up to eight unique nonempty queries).
This is a deterministic retrieval policy, **not yet an iterative planner/critic**.
The report still uses one budgeted inference call. Search/adapters remain host-funded;
`budgetUsd` caps inference reservations, not all external service charges.

The market CLI accepts `--effort low|medium|high` and
`--evidence-policy disclose|strict`. General topics and adapter configuration are
currently library APIs. `sourceUrls` supplies routing context, not automatic page
retrieval; configure search, an adapter, or pass captured `sources`.

Evidence is filtered before deduplication, so future-dated duplicates cannot hide
eligible snapshots. A full page replaces a snippet at the same canonical URL;
fragments and known tracking parameters are removed for identity, while semantic
query parameters remain distinct. This is URL deduplication, not event-level or
syndication deduplication. `run.retrieval` and `retrieval.json` record search failures,
adapter outcomes, and excluded sources. Ordinary search continues when an adapter
fails. Missing market resolution rules now prevent retrieval as well as generation.

`disclose` preserves unknown-date evidence with explicit limitations. `strict`
requires both a valid publication timestamp and a snapshot retrieved no later than
the cutoff. Thus a current retrieval of an old page cannot silently pass as a
historical snapshot. Timestamp assertions remain supplied by the caller/search
provider; this does not authenticate archives or eliminate model training leakage.

Adapters implement `SourceAdapter` and return ordinary evidence plus limitations.
Routing uses exact URL hosts from source/rule context. Adapters receive an abort
signal and must honor it; custom search providers must also honor their signal.
Replay never runs adapters or searches. Built-in adapters are opt-in:

- **Pyth:** requires an exact feed ID and API key. Uses the upgraded Hermes endpoint,
  preserves decimal precision, confidence magnitude, publication time, and raw price
  fields; rejects stale/future latest observations and mismatched feed responses.
  The default freshness window is 300 seconds and can be overridden explicitly.
  `search=WTI` does not establish asset/currency/contract identity. No historical
  threshold crossing is inferred from a latest quote.
- **PortWatch:** adapts the predictor reference's ArcGIS retrieval using an explicit
  port ID. Retrieves up to 30 daily transit-call records; computes the latest mean
  only for seven consecutive calendar days. Null counts are rejected, not treated
  as zero. Dates are observation dates; publication/revision times remain unknown,
  so strict historical policy excludes these current snapshots.
- **Arena:** retains the existing exact-board parser and chronology checks. Generic
  evidence remains in the prompt alongside the specialized brief. Broader board
  layouts and automatic browser extraction remain future work.
- **SecondMarket:** no endpoint or authenticated valuation parser is implemented.
  Supply captured evidence or a custom adapter; price per share, implied valuation,
  funding-round valuation, and indications of interest must remain distinct.

Implementation reference: `predictor/src/research/source-adapters` (Arena and
PortWatch). Pyth API reference checked September 7, 2026:
[Fetch price updates](https://docs.pyth.network/price-feeds/core/fetch-price-updates).
No paid live adapter or cloud inference calls were used for the regression fixtures.

Next general-engine priorities: budget-reserved planning/critique rounds, structured
claims with passage-level provenance and citation verification, event-level evidence
deduplication, and evaluation fixtures independent of the writer's answer key.

A TypeScript/Node library for generating evidence-led research reports without crossing a configured inference budget. It is deliberately library-first: the CLI is only a thin wrapper around `ResearchClient`.

## What the MVP does

- fetches a Polymarket event by slug from the public Gamma API;
- preserves a per-run event snapshot, report, evidence bundle, and cost ledger;
- supports local Ollama and priced OpenRouter inference;
- reserves the maximum estimated cloud cost before each LLM call, then reconciles provider-reported actual cost;
- fails closed if the market lacks a resolution source;
- excludes dated evidence published after the run's `asOf` cutoff;
- lets the host application inject a `SearchProvider`, or pass its own retrieved evidence.
- includes a JSON-based weighted-criteria evaluation baseline for evergreen and temporal suites.

The package does not bundle a search vendor. That is intentional: source access, privacy, and pricing vary across host projects. A `SearchProvider` returns normalized `SourceDocument` objects, so a caller can use Brave, Tavily, an internal corpus, or a cached test fixture without changing the pipeline.

For a local, cost-conscious automatic-search baseline, `SearxngSearchProvider` connects to a self-hosted SearXNG instance. SearXNG has a JSON search API when `json` is enabled in the instance's `search.formats`; the adapter fetches and snapshots the selected public pages by default. It is retrieval, while Ollama remains the inference backend.

Start the included local-only service with Docker Desktop:

```powershell
docker compose up -d
Invoke-RestMethod "http://127.0.0.1:8080/search?q=arena.ai&format=json"
```

The port binds only to `127.0.0.1`; the generated SearXNG secret is held in ignored `.env`. Stop it with `docker compose down` (the named search cache remains); remove the cache explicitly with `docker compose down --volumes`.

```ts
import { OllamaProvider, ResearchClient, SearxngSearchProvider } from "budget-researcher";

const client = new ResearchClient({
  provider: new OllamaProvider("your-local-model"),
  searchProvider: new SearxngSearchProvider({ baseUrl: "http://127.0.0.1:8080" }),
});
```

## Requirements

Node 22+ and pnpm. Install build/test dependencies once with `pnpm install`.
`pnpm start` compiles TypeScript to JavaScript before launching the CLI, so it also
works on Node 23.3.0 without native TypeScript support. `pnpm build` emits JavaScript
and declaration files in `dist/` for downstream library consumers.

## CLI

Install dependencies, then run this single-line command in Bash, Git Bash, PowerShell, or CMD:

```sh
pnpm install
pnpm start -- market which-company-has-the-best-ai-model-end-of-september-20260717143435868 --provider ollama --model qwen3.8:27b --budget 0 --searxng-url http://127.0.0.1:8080 --eval-file test/fixtures/arena-september-2026.json --eval-case pm-arena-text-overall-sept-2026-v1 --out runs
```

The separator after `start` is optional. For multiline commands, Bash uses a
trailing backslash (`\`); PowerShell uses a trailing backtick. Do not mix them.
For OpenRouter, set `OPENROUTER_API_KEY` in your shell and change `--provider`,
`--model`, and `--budget` accordingly. `--help` lists available flags;
`--ollama-url` overrides the default `http://127.0.0.1:11434`.

For local inference, use `--provider ollama --model <local-model>`. `--searxng-url` enables automatic search and bounded page snapshots; each optional `--source` is also stored as evidence. Without either source input or a search adapter, the report explicitly says that it has only market metadata.

## Library use

```ts
import { FileRunStore, OpenRouterProvider, ResearchClient } from "budget-researcher";

const client = new ResearchClient({
  provider: new OpenRouterProvider("provider/model", process.env.OPENROUTER_API_KEY!),
  store: new FileRunStore("./runs"),
  searchProvider: {
    async search(query, { limit }) {
      // Return normalized documents from your selected provider or internal index.
      return [];
    },
  },
});

const run = await client.researchMarket({ slug: "market-slug", budgetUsd: 1, asOf: new Date() });
console.log(run.reportMarkdown, run.ledger.spentUsd);
```

## Test and package checks

```powershell
pnpm test
pnpm check
```

`loadEvaluationCases()` accepts a reviewed JSON array of test cases. Each case contains weighted atomic criteria, transparent required phrases for the no-cost baseline, a budget, cutoff, and optional forbidden phrases. `evaluateRun()` returns criterion-level coverage, citation signal, budget compliance, and an aggregate score. Keep richer semantic/citation-entailment judging as a sampled, explicitly budgeted second layer.

Passing `--eval-file` and `--eval-case` also supplies the rubric's human-reviewed assertions to the report writer, then prints the deterministic evaluation result after the run. This is the review loop: revise the case when the desired behavior changes; revise the pipeline only when multiple cases expose the same defect.

## Review workflow

The working agreement for this project is that the assistant runs research, reads
the report and saved evidence, diagnoses failures, and brings the user a report
with concrete questions for feedback. The user need not run shell commands between
iterations. Use local Ollama and the configured zero-dollar inference budget by
default; broader paid runs require a user-specified budget.

Each evaluated run saves `evaluation.json`, `rubric.json`, `prompt.json`, the report,
sources, Gamma snapshot, and generation metadata. An empty response has status
`empty_response`; an exhausted output limit has status `output_truncated`. Neither
can earn a successful evaluation score. `complete` means generation finished, not
that research quality passed review. The current keyword evaluator is only a smoke
check: it does not verify factual accuracy, source entailment, or semantic coverage.

For directed research, repeat `--query` to replace the two generic title searches
(maximum eight unique queries), and use `--source` for key primary pages. These
options are intentionally distinct from the evaluation answer key. Retrieval pages
have timeouts and snippet fallbacks are labeled in evidence. `--max-output-tokens`
controls generation length (default 4096). The writer disables Ollama thinking
by default, uses a 32768-token local context, and records its finish reason.

Outstanding research-quality work includes semantic criterion judging, reliable
leaderboard table extraction, release-to-listing history, claim-specific source
checks, and a complete cutoff/replay policy. Unknown publication dates cannot
prove historical availability. Treat current results as drafts requiring review.

`--replay-run runs/<id>` rewrites a saved run using the same evidence, market
snapshot, and cutoff. It makes no retrieval calls and records `parentRunId` in a
new run directory. This supports cheap comparisons of prompts or local models;
changing the retrieval strategy still requires a new live run. It is not a clean
historical forecasting backtest: a model can know later events from training.

### Structured Arena evidence

For the exact Arena Text Overall, no-style-control resolution URL, the client
parses a fetched leaderboard page into separate rank, rank range, model, provider,
score, score uncertainty, votes, and explicit Preliminary marker fields. It renders
the top 20 in code, outside the model-written narrative. Unknown table layouts,
missing dates, or ambiguous top-20 rows withhold the table instead of guessing.
Rows dated after the research cutoff are also withheld. The current adapter has
an explicit provider vocabulary and requires contiguous numbered rows; new layouts
and unrecognized providers may require adapter updates.

`structured-evidence.json` retains parsed rows and their source text, a board data
date separate from retrieval time, per-lab release passages with source offsets,
and document-date evidence. Document dates do not automatically prove launch dates
or unrestricted availability. Older board snapshots cannot establish a newly
announced model's post-release performance. Same-day dates do not prove ordering.
Only fully parsed boards may establish absence from the whole board; partial
parsing is disclosed. The parser does not measure first-listing dates or empirical
release-to-listing lag.

`narrative.md` preserves the unmodified model response; `report.md` adds the
deterministic table and chronology guardrails. The narrative still requires factual
review, even when extraction and generation succeed. This adapter does not turn
the keyword score into a semantic quality measure or fix claim-specific source
tiering. Run small offline extraction/date tests before paying for additional
end-to-end evaluations. The generic non-Arena research path remains available.
