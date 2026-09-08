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
  active?: boolean;
  archived?: boolean;
  groupItemTitle?: string;
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
  negRisk?: boolean;
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
  dependencyOf?: string;
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

export type StopReason = "complete" | "partial" | "no_evidence" | "budget_exhausted" | "missing_resolution_rules" | "no_provider" | "error" | "empty_response" | "output_truncated";

export interface ResearchRun {
  id: string;
  parentRunId?: string;
  topic: string;
  asOf: string;
  createdAt: string;
  event?: PolymarketEvent;
  sources: SourceDocument[];
  reportMarkdown: string;
  narrativeMarkdown?: string;
  retrieval?: { searches: Array<{ query: string; status: "complete" | "failed"; documents: number }>; adapters: import("./source-adapters.ts").AdapterDiagnostic[]; excluded: import("./evidence.ts").EvidenceDecision[]; policy: import("./evidence.ts").EvidencePolicy };
  arenaEvidence?: { snapshot: ArenaSnapshot; brief: ArenaEvidenceBrief };
  ledger: RunLedger;
  stopReason: StopReason;
  limitations: string[];
  generation?: { model: string; thinking?: boolean; maxOutputTokens: number; finishReason?: string; promptCharacters: number };
  promptMessages?: ChatMessage[];
  decomposition?: {
    units: ResearchUnit[];
    dossiers: ResearchDossier[];
    limitations: string[];
    raceOdds?: import("./senate-evidence.ts").RaceOddsSnapshot[];
    senateRoster?: import("./senate-evidence.ts").SenateRoster;
  };
}

export interface ResearchUnit {
  name: string;
  kind: "candidate" | "unlisted_candidate" | "race" | "dependency" | "discovery";
  question: string;
  queries: string[];
}

export interface ResearchDossier {
  unit: ResearchUnit;
  reportMarkdown: string;
  narrativeMarkdown?: string;
  sourceNumbers: number[];
  status: StopReason;
  promptMessages: ChatMessage[];
}

export interface ResearchMarketRequest {
  slug: string;
  asOf?: Date;
  budgetUsd: number;
  sources?: SourceDocument[];
  requirements?: string[];
  maxOutputTokens?: number;
  thinking?: boolean;
  queries?: string[];
  evidencePolicy?: import("./evidence.ts").EvidencePolicy;
  effort?: "low" | "medium" | "high";
}

export interface ResearchTopicRequest extends Omit<ResearchMarketRequest, "slug"> {
  topic: string;
  sourceUrls?: string[];
}

export interface RunStore {
  save(run: ResearchRun): Promise<void>;
}
