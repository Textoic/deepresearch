#!/usr/bin/env node
import { parseCliArgs, USAGE } from "./cli-args.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateRun, FallbackSearchProvider, FileRunStore, loadEvaluationCases, OllamaProvider, OpenRouterProvider, ResearchClient, SearxngSearchProvider, SerperSearchProvider } from "./index.ts";
import type { SearchProvider } from "./types.ts";
import type { EvaluationCase } from "./eval.ts";
import { classifySourceTier } from "./source-tier.ts";
import type { ResearchRun, SourceDocument } from "./types.ts";

type Flags = ReturnType<typeof parseCliArgs> & { help: false };

const CLEAN_STOP_REASONS = new Set(["complete", "partial"]);

const EVALUATOR_NOTE = "Keyword checks are diagnostic only, not semantic validation or citation verification.";

function createProvider(flags: Flags) {
  if (flags.provider === "ollama") return new OllamaProvider(flags.model, flags.ollamaUrl ?? process.env.OLLAMA_BASE_URL);
  return new OpenRouterProvider(flags.model, process.env.OPENROUTER_API_KEY ?? flags.apiKey ?? "");
}

async function selectEvaluationCase(flags: { evalFile?: string; evalCase?: string }) {
  if (typeof flags.evalFile !== "string") return undefined;
  const cases = await loadEvaluationCases(flags.evalFile);
  const selected = typeof flags.evalCase === "string" ? cases.find((testCase) => testCase.id === flags.evalCase) : cases.length === 1 ? cases[0] : undefined;
  if (!selected) throw new Error("Specify --eval-case when --eval-file contains more than one case.");
  return selected;
}

function toPlainText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function loadSources(urls: string | string[]): Promise<SourceDocument[]> {
  const list = Array.isArray(urls) ? urls : [urls];
  return Promise.all(list.filter(Boolean).map(async (url) => {
    const response = await fetch(url, { headers: { accept: "text/html,text/plain,application/json" }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Source fetch failed for ${url}: ${response.status}`);
    const raw = await response.text();
    return { url, text: toPlainText(raw), retrievedAt: new Date().toISOString(), sourceTier: classifySourceTier(url), retrievalKind: "page" as const };
  }));
}

function serperKeyOf(flags: Flags): string {
  const key = flags.serperKey ?? process.env.SERPER_API_KEY ?? "";
  if (!key.trim()) throw new Error("--search serper requires --serper-key or the SERPER_API_KEY environment variable.");
  return key;
}

function createSearchProvider(flags: Flags): SearchProvider | undefined {
  const searxng = flags.searxngUrl ? new SearxngSearchProvider({ baseUrl: flags.searxngUrl }) : undefined;
  if (flags.search === "searxng") return searxng;
  const serper = new SerperSearchProvider({ apiKey: serperKeyOf(flags) });
  if (flags.search === "serper" || !searxng) return serper;
  return new FallbackSearchProvider([{ id: "serper", provider: serper }, { id: "searxng", provider: searxng }]);
}

function buildRequest(flags: Flags, evaluationCase: EvaluationCase | undefined, sources: SourceDocument[]) {
  return { slug: flags.slug, budgetUsd: flags.budgetUsd, asOf: flags.asOf, sources, queries: flags.queries, effort: flags.effort, evidencePolicy: flags.evidencePolicy, maxOutputTokens: flags.maxOutputTokens, requirements: evaluationCase?.mustCover.map((criterion) => criterion.assertion) };
}

async function executeRun(client: ResearchClient, flags: Flags, request: ReturnType<typeof buildRequest>): Promise<ResearchRun> {
  if (!flags.replayRun) return client.researchMarket(request);
  const saved = JSON.parse(await readFile(join(flags.replayRun, "run.json"), "utf8")) as ResearchRun;
  return client.rewriteRun(saved, request);
}

function reportRun(run: ResearchRun): void {
  console.log(run.reportMarkdown);
  console.error(`\nrun=${run.id} stop_reason=${run.stopReason} spend=$${run.ledger.spentUsd.toFixed(6)} cap=$${run.ledger.hardCapUsd.toFixed(6)}`);
  const snapshot = run.arenaEvidence?.snapshot;
  if (snapshot) console.error(`arena_extraction=${snapshot.status} data_date=${snapshot.dataDate ?? "unknown"} parsed_rows=${snapshot.rows.length} complete_board=${snapshot.completeBoard}; narrative still requires factual review`);
  if (run.stopReason === "complete") return;
  for (const limitation of run.limitations) console.error(limitation);
  if (!CLEAN_STOP_REASONS.has(run.stopReason)) process.exitCode = 1;
}

async function writeEvaluation(outDirectory: string, run: ResearchRun, evaluationCase: EvaluationCase): Promise<void> {
  const evaluation = evaluateRun(run, evaluationCase);
  const report = { ...evaluation, evaluator: "keyword-smoke-v1", rubricAsOf: evaluationCase.asOf, runAsOf: run.asOf, note: EVALUATOR_NOTE };
  await writeFile(join(outDirectory, run.id, "evaluation.json"), JSON.stringify(report, null, 2));
  await writeFile(join(outDirectory, run.id, "rubric.json"), JSON.stringify(evaluationCase, null, 2));
  console.error(`evaluation=${JSON.stringify(evaluation)}`);
}

async function main() {
  const flags = parseCliArgs(process.argv.slice(2));
  if (flags.help) { console.log(USAGE); return; }
  const evaluationCase = await selectEvaluationCase(flags);
  console.error(flags.replayRun ? "Reusing saved event and evidence; no retrieval calls." : "Fetching supplied sources and market metadata...");
  const sources = flags.replayRun ? [] : await loadSources(flags.sources);
  const searchProvider = createSearchProvider(flags);
  const client = new ResearchClient({ provider: createProvider(flags), searchProvider, store: new FileRunStore(flags.out) });
  console.error(`Researching with ${flags.model}; up to ${flags.maxOutputTokens} output tokens. Local generation may take several minutes.`);
  const run = await executeRun(client, flags, buildRequest(flags, evaluationCase, sources));
  reportRun(run);
  if (evaluationCase) await writeEvaluation(flags.out, run, evaluationCase);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
