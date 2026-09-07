import { extractArenaSnapshot, isArenaTarget, renderArenaSnapshot } from "./arena.ts";
import { buildArenaEvidenceBrief } from "./evidence-brief.ts";
import { renderDossiers, synthesisContext } from "./decomposition-render.ts";
import { renderSenateEvidence } from "./senate-report.ts";
import { selectExcerpt } from "./report-prompt.ts";
import type { EvidencePolicy } from "./evidence.ts";
import type { ChatMessage, PolymarketEvent, ResearchMarketRequest, ResearchRun, SourceDocument } from "./types.ts";

export interface GenerationOutcome {
  reportMarkdown: string;
  narrativeMarkdown?: string;
  stopReason: ResearchRun["stopReason"];
  generation?: ResearchRun["generation"];
  promptMessages?: ChatMessage[];
}

const SYNTHESIS_SOURCES = 6;
const SYNTHESIS_EXCERPT_CHARACTERS = 1400;
const SYNTHESIS_TERMS = new Set(["seats", "incumbent", "majority", "vice", "caucus", "announced"]);
const INCOMPLETE_DISCOVERY = /Discovery incomplete|Not every planned/;

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

function decompositionFailed(decomposition: NonNullable<ResearchRun["decomposition"]>): boolean {
  return decomposition.dossiers.some(dossier => dossier.status !== "complete") || decomposition.limitations.some(limitation => INCOMPLETE_DISCOVERY.test(limitation));
}

export function finalStopReason(outcome: GenerationOutcome, decomposition: ResearchRun["decomposition"]): ResearchRun["stopReason"] {
  if (!decomposition || outcome.stopReason !== "complete") return outcome.stopReason;
  return decompositionFailed(decomposition) ? "error" : "complete";
}

export function withDecomposition(reportMarkdown: string, decomposition: NonNullable<ResearchRun["decomposition"]>): string {
  const senateEvidence = decomposition.raceOdds?.length && !decomposition.senateRoster
    ? `${renderSenateEvidence(decomposition.raceOdds, decomposition.senateRoster)}\n\n# Research synthesis\n\n` : "";
  return senateEvidence + reportMarkdown + renderDossiers(decomposition);
}

export function synthesisSources(sources: SourceDocument[], decomposition: ResearchRun["decomposition"]): SourceDocument[] {
  if (!decomposition?.dossiers.length) return sources;
  return sources.slice(0, SYNTHESIS_SOURCES).map(source => ({ ...source, text: selectExcerpt(source.text, SYNTHESIS_EXCERPT_CHARACTERS, SYNTHESIS_TERMS) }));
}

export function annotate(messages: ChatMessage[], decomposition: ResearchRun["decomposition"], arenaEvidence: ResearchRun["arenaEvidence"], limitations: string[]): ChatMessage[] {
  const extras = [
    decomposition ? `\n\n${synthesisContext(decomposition)}` : "",
    arenaEvidence ? "\nWrite NARRATIVE ONLY; the application renders the structured table separately." : "",
    `\n\nRetrieval limitations (disclose relevant gaps):\n${limitations.join("\n")}`,
  ];
  messages[1]!.content += extras.join("");
  return messages;
}
