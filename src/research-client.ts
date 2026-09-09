import { selectEvidence, type EvidencePolicy } from "./evidence.ts";
import { citationIntegrityLimitation, linkSourceReferences, unfoundedCitations } from "./citations.ts";
import { renderSenateReport } from "./senate-report.ts";
import { normalizeMarketEvent } from "./market-policy.ts";
import { clarificationAdapters } from "./clarification-adapter.ts";
import { decomposeMarket } from "./market-decomposition.ts";
import { retrievalQueries } from "./market-units.ts";
import { collectAdapterSources, extractSourceUrls, type SourceAdapter } from "./source-adapters.ts";
import { randomUUID } from "node:crypto";
import { BudgetExceededError, BudgetGuard } from "./budget.ts";
import { PolymarketClient } from "./polymarket.ts";
import { isArenaTarget } from "./arena.ts";
import { buildMessages, preliminaryReport, sourceLimitations, topicReport } from "./report-prompt.ts";
import { annotate, arenaContext, finalStopReason, NO_EVIDENCE, resolutionRules, retrievalCollapsed, synthesisSources, validatedPolicy, withArenaFraming, withDecomposition, type GenerationOutcome } from "./run-assembly.ts";
import { evidenceBaseSummary } from "./source-tier.ts";
import type { ChatMessage, InferenceProvider, PolymarketEvent, ResearchMarketRequest, ResearchRun, RunStore, SearchProvider, SourceDocument, ResearchTopicRequest } from "./types.ts";

export interface ResearchClientOptions {
  provider: InferenceProvider;
  store?: RunStore;
  polymarket?: PolymarketClient;
  searchProvider?: SearchProvider;
  sourceAdapters?: SourceAdapter[];
}

interface RunOptions {
  parentRunId?: string;
  topicMode?: boolean;
  previousDecomposition?: ResearchRun["decomposition"];
}

interface EvidenceBundle {
  sources: SourceDocument[];
  retrieval: NonNullable<ResearchRun["retrieval"]>;
  limitations: string[];
}

const RETRIEVAL_TIMEOUT_MS = 30_000;
const RESULTS_PER_QUERY = 6;
const MAX_INPUT_TOKENS = 24_000;
const DEFAULT_OUTPUT_TOKENS = 4_096;
const DEGRADABLE_STOP_REASONS = new Set(["complete", "partial"]);

export class ResearchClient {
  private readonly market: PolymarketClient;
  private readonly options: ResearchClientOptions;
  constructor(options: ResearchClientOptions) { this.options = options; this.market = options.polymarket ?? new PolymarketClient(); }

  async researchMarket(request: ResearchMarketRequest): Promise<ResearchRun> {
    const event = await this.market.getEventBySlug(request.slug);
    return this.runResearch(event, request);
  }

  async researchEvent(event: PolymarketEvent, request: ResearchMarketRequest): Promise<ResearchRun> {
    return this.runResearch(event, request);
  }

  async researchTopic(request: ResearchTopicRequest): Promise<ResearchRun> {
    if (!request.topic.trim()) throw new Error("topic must not be empty.");
    const context: PolymarketEvent = { id: "topic", slug: "topic", title: request.topic, description: (request.sourceUrls ?? []).join("\n"), raw: null };
    return this.runResearch(context, { ...request, slug: "topic" }, { topicMode: true });
  }

  async rewriteRun(previous: ResearchRun, request: ResearchMarketRequest): Promise<ResearchRun> {
    if (!previous.event || previous.event.slug !== request.slug) throw new Error("Replay snapshot does not match the requested market.");
    const changed = request.clarification !== undefined && request.clarification !== previous.event.clarification;
    return this.runResearch(previous.event, { ...request, asOf: new Date(previous.asOf), sources: previous.sources }, { parentRunId: previous.id, previousDecomposition: changed ? undefined : previous.decomposition });
  }

  private async gatherEvidence(event: PolymarketEvent, request: ResearchMarketRequest, state: { asOf: string; policy: EvidencePolicy; canResearch: boolean; skipRetrieval: boolean; topicMode: boolean }): Promise<EvidenceBundle> {
    const live = state.canResearch && !state.skipRetrieval;
    const rules = resolutionRules(event);
    const adapted = live ? await collectAdapterSources([...clarificationAdapters(event.clarification), ...this.options.sourceAdapters ?? []], { topic: event.title, rules, urls: extractSourceUrls(rules), asOf: state.asOf, signal: AbortSignal.timeout(RETRIEVAL_TIMEOUT_MS) }) : { documents: [], diagnostics: [] };
    const retrieved = live ? await this.retrieveEventSources(event, request, state.topicMode) : { sources: [], searches: [] };
    const selection = selectEvidence([...(request.sources ?? []), ...adapted.documents, ...retrieved.sources], state.asOf, state.policy);
    const limitations = [
      ...sourceLimitations(event, selection.sources, state.asOf, state.topicMode), ...selection.warnings,
      ...adapted.diagnostics.flatMap(diagnostic => diagnostic.limitations.map(message => `${diagnostic.id}: ${message}`)),
      ...retrieved.searches.filter(search => search.status === "failed").map(search => `Search failed: ${search.query}`),
    ];
    return { sources: selection.sources, limitations, retrieval: { searches: retrieved.searches, adapters: adapted.diagnostics, excluded: selection.excluded, policy: state.policy } };
  }

  private async resolveDecomposition(event: PolymarketEvent, request: ResearchMarketRequest, state: { asOf: string; evidence: EvidenceBundle; guard: BudgetGuard; canResearch: boolean; topicMode: boolean; options: RunOptions }): Promise<ResearchRun["decomposition"]> {
    if (state.options.previousDecomposition) return structuredClone(state.options.previousDecomposition);
    const eligible = !state.topicMode && !state.options.parentRunId && state.canResearch && request.effort === "high" && !isArenaTarget(event.resolutionSource ?? "");
    if (!eligible) return undefined;
    return decomposeMarket({ event, request, asOf: state.asOf, sources: state.evidence.sources, searches: state.evidence.retrieval.searches, excluded: state.evidence.retrieval.excluded, provider: this.options.provider, search: this.options.searchProvider, guard: state.guard });
  }

  private async generate(request: ResearchMarketRequest, state: { event: PolymarketEvent; asOf: string; sources: SourceDocument[]; arenaEvidence: ResearchRun["arenaEvidence"]; decomposition: ResearchRun["decomposition"]; limitations: string[]; topicMode: boolean; guard: BudgetGuard; fallback: string }): Promise<GenerationOutcome> {
    const prompt = buildMessages({ event: state.event, asOf: state.asOf, sources: synthesisSources(state.sources, state.decomposition, state.event), requirements: request.requirements ?? [], arenaEvidence: state.arenaEvidence, topicMode: state.topicMode });
    const messages = annotate(prompt, { decomposition: state.decomposition, arenaEvidence: state.arenaEvidence, limitations: state.limitations, topicMode: state.topicMode });
    const chatRequest = { messages, maxInputTokens: MAX_INPUT_TOKENS, maxOutputTokens: request.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS, thinking: request.thinking ?? false, temperature: 0.2 } as const;
    const generation: ResearchRun["generation"] = { model: this.options.provider.model, thinking: chatRequest.thinking, maxOutputTokens: chatRequest.maxOutputTokens, promptCharacters: messages.reduce((total, message) => total + message.content.length, 0) };
    try {
      const estimate = await this.options.provider.estimateCost(chatRequest);
      const reservation = state.guard.reserve(estimate);
      const response = await this.options.provider.complete(chatRequest);
      state.guard.settle("grounded_report", reservation, response, estimate.usd);
      generation.finishReason = response.finishReason;
      const stop = this.classifyResponse(response, chatRequest.maxOutputTokens, state.limitations);
      return { reportMarkdown: linkSourceReferences(response.content, state.sources), narrativeMarkdown: response.content, stopReason: stop, generation, promptMessages: messages };
    } catch (error) {
      return { reportMarkdown: state.fallback, stopReason: this.classifyFailure(error, state.limitations), generation, promptMessages: messages };
    }
  }

  private classifyResponse(response: { content: string; usage: { outputTokens: number }; finishReason?: string }, maxOutputTokens: number, limitations: string[]): ResearchRun["stopReason"] {
    if (!response.content.trim()) {
      limitations.push("The model returned no report text. Output tokens may have been consumed before a final answer. This run must not count as successful research.");
      return "empty_response";
    }
    if (response.finishReason === "length" || response.usage.outputTokens >= maxOutputTokens) {
      limitations.push("The model exhausted its output limit. The saved report is partial.");
      return "output_truncated";
    }
    return "complete";
  }

  private classifyFailure(error: unknown, limitations: string[]): ResearchRun["stopReason"] {
    if (error instanceof BudgetExceededError) {
      limitations.push(`No report-generation call was made: ${error.message}`);
      return "budget_exhausted";
    }
    limitations.push(`Research call failed: ${error instanceof Error ? error.message : String(error)}`);
    return "error";
  }

  private async writeReport(request: ResearchMarketRequest, state: { event: PolymarketEvent; asOf: string; sources: SourceDocument[]; arenaEvidence: ResearchRun["arenaEvidence"]; decomposition: ResearchRun["decomposition"]; limitations: string[]; topicMode: boolean; guard: BudgetGuard; canResearch: boolean; noEvidence: boolean }): Promise<GenerationOutcome> {
    const fallback = state.topicMode ? topicReport(state.event, state.asOf, state.sources, state.limitations) : preliminaryReport(state.event, state.asOf, state.sources, state.limitations);
    if (!state.canResearch) {
      state.limitations.push("Gamma metadata has no resolution source. The system will not invent a forecast.");
      return { reportMarkdown: fallback, stopReason: "missing_resolution_rules" };
    }
    if (state.noEvidence) return { reportMarkdown: fallback, stopReason: "no_evidence" };
    const roster = state.decomposition?.senateRoster;
    if (roster && state.decomposition?.raceOdds?.length) {
      return { reportMarkdown: renderSenateReport(state.event, state.asOf, state.decomposition.raceOdds, roster), stopReason: "complete" };
    }
    return this.generate(request, { ...state, fallback });
  }

  private auditCitations(reportMarkdown: string, sources: SourceDocument[], limitations: string[], stopReason: ResearchRun["stopReason"]): ResearchRun["stopReason"] {
    const unfounded = unfoundedCitations(reportMarkdown, sources);
    if (!unfounded.length) return stopReason;
    limitations.push(citationIntegrityLimitation(unfounded));
    return DEGRADABLE_STOP_REASONS.has(stopReason) ? "partial" : stopReason;
  }

  private async planResearch(event: PolymarketEvent, request: ResearchMarketRequest, state: { asOf: string; evidence: EvidenceBundle; guard: BudgetGuard; canResearch: boolean; topicMode: boolean; options: RunOptions }): Promise<{ noEvidence: boolean; decomposition: ResearchRun["decomposition"] }> {
    const { sources, retrieval, limitations } = state.evidence;
    if (retrievalCollapsed(retrieval, sources)) {
      limitations.push(NO_EVIDENCE);
      return { noEvidence: true, decomposition: undefined };
    }
    const decomposition = await this.resolveDecomposition(event, request, state);
    if (decomposition) this.applyDecomposition(decomposition, sources, limitations);
    return { noEvidence: false, decomposition };
  }

  private async runResearch(original: PolymarketEvent, request: ResearchMarketRequest, options: RunOptions = {}): Promise<ResearchRun> {
    const topicMode = options.topicMode ?? false;
    const event = topicMode ? original : normalizeMarketEvent({ ...original, clarification: request.clarification ?? original.clarification });
    const asOf = (request.asOf ?? new Date()).toISOString();
    const guard = new BudgetGuard(request.budgetUsd);
    const policy = validatedPolicy(request);
    const canResearch = topicMode || !!event.resolutionSource?.trim();
    const evidence = await this.gatherEvidence(event, request, { asOf, policy, canResearch, skipRetrieval: !!options.parentRunId, topicMode });
    const { sources, retrieval, limitations } = evidence;
    const { noEvidence, decomposition } = await this.planResearch(event, request, { asOf, evidence, guard, canResearch, topicMode, options });
    limitations.push(evidenceBaseSummary(sources));
    const arenaEvidence = arenaContext(event, sources, asOf);
    if (arenaEvidence) limitations.push(...arenaEvidence.snapshot.issues);
    const outcome = await this.writeReport(request, { event, asOf, sources, arenaEvidence, decomposition, limitations, topicMode, guard, canResearch, noEvidence });
    const reportMarkdown = this.assemble(outcome, arenaEvidence, decomposition);
    const stopReason = this.auditCitations(reportMarkdown, sources, limitations, finalStopReason(outcome, decomposition));
    const run: ResearchRun = { id: randomUUID(), topic: event.title, asOf, createdAt: guard.ledger.startedAt, event: topicMode ? undefined : event, sources, retrieval, reportMarkdown,
      narrativeMarkdown: outcome.narrativeMarkdown, arenaEvidence, decomposition, ledger: guard.finish(), stopReason, limitations,
      generation: outcome.generation, promptMessages: outcome.promptMessages, parentRunId: options.parentRunId };
    await this.options.store?.save(run);
    return run;
  }

  private applyDecomposition(decomposition: NonNullable<ResearchRun["decomposition"]>, sources: SourceDocument[], limitations: string[]): void {
    limitations.push(...decomposition.limitations);
    for (const dossier of decomposition.dossiers) {
      dossier.narrativeMarkdown ??= dossier.reportMarkdown;
      dossier.reportMarkdown = linkSourceReferences(dossier.narrativeMarkdown, sources);
    }
  }

  private assemble(outcome: GenerationOutcome, arenaEvidence: ResearchRun["arenaEvidence"], decomposition: ResearchRun["decomposition"]): string {
    const framed = withArenaFraming(outcome.reportMarkdown, arenaEvidence, outcome.narrativeMarkdown);
    return decomposition ? withDecomposition(framed, decomposition) : framed;
  }

  private async retrieveEventSources(event: PolymarketEvent, request: ResearchMarketRequest, topicMode: boolean) {
    const searches: Array<{ query: string; status: "complete" | "failed"; documents: number }> = [];
    const sources: SourceDocument[] = [];
    if (!this.options.searchProvider) return { sources, searches };
    const queries = retrievalQueries(event, request, topicMode);
    const responses = await Promise.allSettled(queries.map(query => this.options.searchProvider!.search(query, { limit: RESULTS_PER_QUERY, signal: AbortSignal.timeout(RETRIEVAL_TIMEOUT_MS) })));
    responses.forEach((result, index) => {
      searches.push({ query: queries[index]!, status: result.status === "fulfilled" ? "complete" : "failed", documents: result.status === "fulfilled" ? result.value.length : 0 });
      if (result.status === "fulfilled") sources.push(...result.value);
    });
    return { sources, searches };
  }
}
