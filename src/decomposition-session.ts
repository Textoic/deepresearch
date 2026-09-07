import { BudgetGuard } from "./budget.ts";
import { selectEvidence } from "./evidence.ts";
import { initialUnits, searchQueries } from "./market-units.ts";
import type { ChatMessage, ChatResult, InferenceProvider, PolymarketEvent, ResearchMarketRequest, ResearchRun, SearchProvider, SourceDocument } from "./types.ts";

export interface DecompositionOptions {
  event: PolymarketEvent;
  request: ResearchMarketRequest;
  asOf: string;
  sources: SourceDocument[];
  searches: NonNullable<ResearchRun["retrieval"]>["searches"];
  excluded: NonNullable<ResearchRun["retrieval"]>["excluded"];
  provider: InferenceProvider;
  search?: SearchProvider;
  guard: BudgetGuard;
}

export type Decomposition = NonNullable<ResearchRun["decomposition"]>;

export const MAX_INPUT_TOKENS = 24000;
export const DOSSIER_TOKENS = 1600;
export const RETRY_TOKENS = 2400;
export const DISCOVERY_TOKENS = 2200;

export abstract class DecompositionSession {
  protected readonly options: DecompositionOptions;
  protected readonly result: Decomposition;

  constructor(options: DecompositionOptions) {
    this.options = options;
    this.result = { units: initialUnits(options.event), dossiers: [], limitations: [] };
  }

  protected get event(): PolymarketEvent { return this.options.event; }
  protected get sources(): SourceDocument[] { return this.options.sources; }
  protected get asOf(): string { return this.options.asOf; }

  protected search(queries: string[]): Promise<SourceDocument[]> {
    return searchQueries(this.options.search, queries, this.options.searches);
  }

  protected accept(documents: SourceDocument[]): number[] {
    const selection = selectEvidence(documents, this.asOf, this.options.request.evidencePolicy ?? "disclose");
    this.options.excluded.push(...selection.excluded);
    this.result.limitations.push(...selection.warnings);
    return selection.sources.map(document => this.sourceNumber(document));
  }

  private sourceNumber(document: SourceDocument): number {
    const existing = this.sources.findIndex(source => source.url === document.url);
    return existing >= 0 ? existing + 1 : this.sources.push(document);
  }

  private truncated(response: ChatResult, maxOutputTokens: number): boolean {
    return response.finishReason === "length" || response.usage.outputTokens >= maxOutputTokens;
  }

  protected async call(stage: string, messages: ChatMessage[], maxOutputTokens: number): Promise<string> {
    const { provider, guard } = this.options;
    const request = { messages, maxInputTokens: MAX_INPUT_TOKENS, maxOutputTokens, thinking: false, temperature: 0.1 };
    const estimate = await provider.estimateCost(request);
    const reservation = guard.reserve(estimate);
    const response = await provider.complete(request);
    guard.settle(stage, reservation, response, estimate.usd);
    if (!response.content.trim()) throw new Error(`${stage}: empty response`);
    if (!this.truncated(response, maxOutputTokens)) return response.content;
    if (stage.startsWith("dossier:") && maxOutputTokens === DOSSIER_TOKENS) return this.call(`${stage}:length-retry`, messages, RETRY_TOKENS);
    throw new Error(`${stage}: output truncated`);
  }
}
