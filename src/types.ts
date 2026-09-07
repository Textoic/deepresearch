import type { ArenaSnapshot } from "./arena.ts";
import type { ArenaEvidenceBrief } from "./evidence-brief.ts";

export type ProviderKind = "ollama" | "openrouter" | "custom";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxInputTokens: number;
  maxOutputTokens: number;
  temperature?: number;
  responseFormat?: "text" | "json";
  thinking?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
}

export interface CostEstimate {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  known: boolean;
}

export interface ChatResult {
  content: string;
  usage: TokenUsage;
  /** Actual provider-reported cost when available. */
  costUsd?: number;
  model: string;
  provider: ProviderKind;
  raw?: unknown;
  finishReason?: string;
}

export interface InferenceProvider {
  readonly kind: ProviderKind;
  readonly model: string;
  estimateCost(request: ChatRequest): Promise<CostEstimate>;
  complete(request: ChatRequest): Promise<ChatResult>;
}

export interface MarketOutcome {
  name: string;
  price?: number;
}

export interface PolymarketMarket {
  id: string;
  question?: string;
  slug?: string;
  description?: string;
  outcomes?: string[] | string;
  outcomePrices?: string[] | string;
  endDate?: string;
  closed?: boolean;
}

export interface PolymarketEvent {
  id: string;
  slug: string;
  title: string;
  description?: string;
  resolutionSource?: string;
  endDate?: string;
  closed?: boolean;
  active?: boolean;
  volume?: number | string;
  liquidity?: number | string;
  markets?: PolymarketMarket[];
  raw: unknown;
}

export interface SourceDocument {
  url: string;
  title?: string;
  text: string;
  publishedAt?: string;
  retrievedAt: string;
  sourceTier?: 1 | 2 | 3 | 4;
  retrievalKind?: "page" | "snippet";
  retrievalError?: string;
}

export interface SearchProvider {
  search(query: string, options: { limit: number; signal?: AbortSignal }): Promise<SourceDocument[]>;
}

export interface LlmCallLedger {
  stage: string;
  provider: ProviderKind;
  model: string;
  estimatedUsd: number;
  actualUsd: number;
  usage: TokenUsage;
}

export interface RunLedger {
  hardCapUsd: number;
  spentUsd: number;
  reservedUsd: number;
  calls: LlmCallLedger[];
  startedAt: string;
  finishedAt?: string;
}

export type StopReason = "complete" | "budget_exhausted" | "missing_resolution_rules" | "no_provider" | "error" | "empty_response" | "output_truncated";

export interface ResearchRun {
  id: string;
  parentRunId?: string;
  topic: string;
  asOf: string;
  createdAt: string;
  event?: PolymarketEvent;
  sources: SourceDocument[];
  reportMarkdown: string;
  /** Unmodified model output; reportMarkdown may also contain deterministic data tables. */
  narrativeMarkdown?: string;
  arenaEvidence?: { snapshot: ArenaSnapshot; brief: ArenaEvidenceBrief };
  ledger: RunLedger;
  stopReason: StopReason;
  limitations: string[];
  generation?: { model: string; thinking?: boolean; maxOutputTokens: number; finishReason?: string; promptCharacters: number };
  promptMessages?: ChatMessage[];
}

export interface ResearchMarketRequest {
  slug: string;
  asOf?: Date;
  /** Hard maximum for paid inference. Local providers still record usage at $0. */
  budgetUsd: number;
  /** Caller-provided or search-adapter-provided evidence. */
  sources?: SourceDocument[];
  /** Human-reviewed analysis requirements, normally derived from an evaluation case. */
  requirements?: string[];
  maxOutputTokens?: number;
  thinking?: boolean;
  queries?: string[];
}

export interface RunStore {
  save(run: ResearchRun): Promise<void>;
}
