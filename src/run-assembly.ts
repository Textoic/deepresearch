import { extractArenaSnapshot, isArenaTarget, renderArenaSnapshot } from "./arena.ts";
import { buildArenaEvidenceBrief } from "./evidence-brief.ts";
import { renderDossiers, synthesisContext } from "./decomposition-render.ts";
import { renderSenateEvidence } from "./senate-report.ts";
import { sectionContract, selectExcerpt, type NumberedSource } from "./report-prompt.ts";
import { byProvenance } from "./source-tier.ts";
import type { EvidencePolicy } from "./evidence.ts";
import type { ChatMessage, PolymarketEvent, ResearchMarketRequest, ResearchRun, SourceDocument } from "./types.ts";

export interface GenerationOutcome {
  reportMarkdown: string;
  narrativeMarkdown?: string;
  stopReason: ResearchRun["stopReason"];
  generation?: ResearchRun["generation"];
  promptMessages?: ChatMessage[];
}

const SYNTHESIS_SOURCES = 10;
const SYNTHESIS_EXCERPT_CHARACTERS = 1400;
const INCOMPLETE_DISCOVERY = /Discovery incomplete|Not every planned/;

export const OPERATIONAL_PREFIX = "Operational: ";

export function validatedPolicy(request: ResearchMarketRequest): EvidencePolicy {
  const policy = request.evidencePolicy ?? "disclose";
  if (!["disclose", "strict"].includes(policy)) throw new Error("Invalid evidence policy.");
  if (request.effort && !["low", "medium", "high"].includes(request.effort)) throw new Error("Invalid research effort.");
  return policy;
}

export function resolutionRules(event: PolymarketEvent): string {
  return [event.resolutionSource, event.description, ...(event.markets ?? []).map(market => market.description)].filter(Boolean).join("\n");
}

function withdrawFutureBoard(snapshot: ReturnType<typeof extractArenaSnapshot>, asOf: string): void {
  if (!snapshot.dataDate || snapshot.dataDate <= asOf.slice(0, 10)) return;
  snapshot.status = "invalid";
  snapshot.rows = [];
  snapshot.completeBoard = false;
  snapshot.issues.push("Leaderboard data date is after the research cutoff; its rows are withheld.");
}

export function arenaContext(event: PolymarketEvent, sources: SourceDocument[], asOf: string): ResearchRun["arenaEvidence"] {
  if (!isArenaTarget(event.resolutionSource ?? "")) return undefined;
  const index = sources.findIndex(source => isArenaTarget(source.url));
  if (index < 0) return undefined;
  const snapshot = extractArenaSnapshot(sources[index]!, index + 1);
  withdrawFutureBoard(snapshot, asOf);
  return { snapshot, brief: buildArenaEvidenceBrief(sources, snapshot, asOf) };
}

function chronologyNotes(arenaEvidence: NonNullable<ResearchRun["arenaEvidence"]>): string[] {
  const boardDate = arenaEvidence.snapshot.dataDate;
  return arenaEvidence.brief.labs.flatMap(lab => lab.documents.filter(document => document.boardRelation === "before")
    .map(document => `- ${lab.lab}: the ${boardDate} board predates this document (${document.documentDate}). It cannot assess a model released with that announcement. A document date alone does not prove unrestricted public access. [Source ${document.sourceNumber}](${document.url})`));
}

export function withArenaFraming(reportMarkdown: string, arenaEvidence: ResearchRun["arenaEvidence"], narrativeMarkdown?: string): string {
  if (!arenaEvidence || !narrativeMarkdown?.trim()) return reportMarkdown;
  return `${renderArenaSnapshot(arenaEvidence.snapshot)}\n## Chronology guardrails\n\n${arenaEvidence.brief.warnings.join("\n\n")}\n\n${chronologyNotes(arenaEvidence).join("\n")}\n\n## Model-written analysis (requires review)\n\n${narrativeMarkdown}`;
}

export function finalStopReason(outcome: GenerationOutcome, decomposition: ResearchRun["decomposition"]): ResearchRun["stopReason"] {
  if (!decomposition || outcome.stopReason !== "complete") return outcome.stopReason;
  const failures = decomposition.dossiers.map(dossier => dossier.status).filter(status => status !== "complete");
  if (failures.includes("budget_exhausted")) return "budget_exhausted";
  if (failures.some(status => status !== "output_truncated")) return "error";
  const incompleteDiscovery = decomposition.limitations.some(limitation => INCOMPLETE_DISCOVERY.test(limitation));
  return failures.length || incompleteDiscovery ? "partial" : "complete";
}

export const NO_EVIDENCE = "Every search returned zero documents, so this run gathered no external evidence. A search provider that answers without results is a retrieval failure, not proof that nothing has been published. No report was generated from it.";

export function retrievalCollapsed(retrieval: NonNullable<ResearchRun["retrieval"]>, sources: SourceDocument[]): boolean {
  if (sources.length || !retrieval.searches.length) return false;
  return retrieval.searches.every(search => search.status === "failed" || search.documents === 0);
}

export function writerLimitations(limitations: string[]): string[] {
  return limitations.filter(limitation => !limitation.startsWith(OPERATIONAL_PREFIX));
}

export function withDecomposition(reportMarkdown: string, decomposition: NonNullable<ResearchRun["decomposition"]>): string {
  const senateEvidence = decomposition.raceOdds?.length && !decomposition.senateRoster
    ? `${renderSenateEvidence(decomposition.raceOdds, decomposition.senateRoster)}\n\n# Research synthesis\n\n` : "";
  return senateEvidence + reportMarkdown + renderDossiers(decomposition);
}

function synthesisTerms(event: PolymarketEvent): Set<string> {
  return new Set(event.title.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
}

export function synthesisSources(sources: SourceDocument[], decomposition: ResearchRun["decomposition"], event: PolymarketEvent): NumberedSource[] {
  const numbered: NumberedSource[] = sources.map((source, index) => ({ number: index + 1, source }));
  if (!decomposition?.dossiers.length) return numbered;
  const terms = synthesisTerms(event);
  return [...numbered]
    .sort((a, b) => byProvenance(a.source, b.source) || a.number - b.number)
    .slice(0, SYNTHESIS_SOURCES)
    .sort((a, b) => a.number - b.number)
    .map(entry => ({ number: entry.number, source: { ...entry.source, text: selectExcerpt(entry.source.text, SYNTHESIS_EXCERPT_CHARACTERS, terms) } }));
}

export interface Annotations {
  decomposition: ResearchRun["decomposition"];
  arenaEvidence: ResearchRun["arenaEvidence"];
  limitations: string[];
  topicMode: boolean;
}

export function annotate(messages: ChatMessage[], annotations: Annotations): ChatMessage[] {
  const { decomposition, arenaEvidence } = annotations;
  const extras = [
    decomposition ? `\n\n${synthesisContext(decomposition)}` : "",
    arenaEvidence ? "\nWrite NARRATIVE ONLY; the application renders the structured table separately." : "",
    `\n\nRetrieval limitations (disclose relevant gaps):\n${writerLimitations(annotations.limitations).join("\n")}`,
    `\n\n${sectionContract(annotations.topicMode)}`,
  ];
  messages[1]!.content += extras.join("");
  return messages;
}
