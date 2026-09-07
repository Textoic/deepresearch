#!/usr/bin/env node
import { parseCliArgs, USAGE } from "./cli-args.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateRun, FileRunStore, loadEvaluationCases, OllamaProvider, OpenRouterProvider, ResearchClient, SearxngSearchProvider } from "./index.ts";
import type { ResearchRun, SourceDocument } from "./types.ts";

async function main() {
  const flags = parseCliArgs(process.argv.slice(2));
  if (flags.help) { console.log(USAGE); return; }
  const provider = flags.provider === "ollama"
    ? new OllamaProvider(flags.model, flags.ollamaUrl ?? process.env.OLLAMA_BASE_URL)
    : new OpenRouterProvider(flags.model, process.env.OPENROUTER_API_KEY ?? flags.apiKey ?? "");
  const evaluationCase = await selectEvaluationCase(flags);
  console.error(flags.replayRun ? "Reusing saved event and evidence; no retrieval calls." : "Fetching supplied sources and market metadata...");
  const sources = flags.replayRun ? [] : await loadSources(flags.sources);
  const searchProvider = flags.searxngUrl ? new SearxngSearchProvider({ baseUrl: flags.searxngUrl }) : undefined;
  const client = new ResearchClient({ provider, searchProvider, store: new FileRunStore(flags.out) });
  console.error(`Researching with ${flags.model}; up to ${flags.maxOutputTokens} output tokens. Local generation may take several minutes.`);
  const request = { slug: flags.slug, budgetUsd: flags.budgetUsd, asOf: flags.asOf, sources, queries: flags.queries, effort: flags.effort, evidencePolicy: flags.evidencePolicy, maxOutputTokens: flags.maxOutputTokens, requirements: evaluationCase?.mustCover.map((criterion) => criterion.assertion) };
  const run = flags.replayRun ? await client.rewriteRun(JSON.parse(await readFile(join(flags.replayRun, "run.json"), "utf8")) as ResearchRun, request) : await client.researchMarket(request);
  console.log(run.reportMarkdown);
  console.error(`\nrun=${run.id} stop_reason=${run.stopReason} spend=$${run.ledger.spentUsd.toFixed(6)} cap=$${run.ledger.hardCapUsd.toFixed(6)}`);
  if (run.arenaEvidence) {
    const snapshot = run.arenaEvidence.snapshot;
    console.error(`arena_extraction=${snapshot.status} data_date=${snapshot.dataDate ?? "unknown"} parsed_rows=${snapshot.rows.length} complete_board=${snapshot.completeBoard}; narrative still requires factual review`);
  }
  if (evaluationCase) {
    const evaluation = evaluateRun(run, evaluationCase);
    await writeFile(join(flags.out, run.id, "evaluation.json"), JSON.stringify({ ...evaluation, evaluator: "keyword-smoke-v1", rubricAsOf: evaluationCase.asOf, runAsOf: run.asOf, note: "Keyword checks are diagnostic only, not semantic validation or citation verification." }, null, 2));
    await writeFile(join(flags.out, run.id, "rubric.json"), JSON.stringify(evaluationCase, null, 2));
    console.error(`evaluation=${JSON.stringify(evaluation)}`);
  }
  if (run.stopReason !== "complete") {
    for (const limitation of run.limitations) console.error(limitation);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
async function loadSources(urls: string | string[]): Promise<SourceDocument[]> {
  const list = Array.isArray(urls) ? urls : [urls];
  return Promise.all(list.filter(Boolean).map(async (url) => {
    const response = await fetch(url, { headers: { accept: "text/html,text/plain,application/json" }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Source fetch failed for ${url}: ${response.status}`);
    const raw = await response.text();
    return { url, text: toPlainText(raw), retrievedAt: new Date().toISOString(), sourceTier: 2 as const, retrievalKind: "page" as const };
  }));
}
async function selectEvaluationCase(flags: { evalFile?: string; evalCase?: string }) {
  if (typeof flags.evalFile !== "string") return undefined;
  const cases = await loadEvaluationCases(flags.evalFile);
  const selected = typeof flags.evalCase === "string" ? cases.find((testCase) => testCase.id === flags.evalCase) : cases.length === 1 ? cases[0] : undefined;
  if (!selected) throw new Error("Specify --eval-case when --eval-file contains more than one case.");
  return selected;
}
function toPlainText(html: string): string { return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
