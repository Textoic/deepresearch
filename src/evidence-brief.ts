import { compareBoardDate, ENGLISH_DATE, isArenaTarget, parseEnglishDate, type ArenaSnapshot } from "./arena.ts";
import type { SourceDocument } from "./types.ts";

export interface EvidencePassage { start: number; end: number; text: string; }
export interface LabDocument {
  sourceNumber: number;
  url: string;
  kind: string;
  documentDate?: string;
  datePassage?: EvidencePassage;
  boardRelation: ReturnType<typeof compareBoardDate>;
  passages: EvidencePassage[];
}
export interface LabEvidence {
  lab: string;
  documents: LabDocument[];
  gaps: string[];
}
export interface ArenaEvidenceBrief {
  labs: LabEvidence[];
  policy: Array<{ sourceNumber: number; url: string; passages: EvidencePassage[] }>;
  warnings: string[];
}

interface Lab { name: string; hosts: string[]; model: RegExp; }

const LABS: Lab[] = [
  { name: "Anthropic", hosts: ["anthropic.com"], model: /claude|fable|mythos/i },
  { name: "OpenAI", hosts: ["openai.com"], model: /gpt|astra/i },
  { name: "Google", hosts: ["blog.google", "deepmind.google"], model: /gemini/i },
  { name: "xAI / SpaceXAI (Grok)", hosts: ["x.ai"], model: /grok/i },
];

const POLICY_TERMS = ["Listing models on the leaderboard", "Evaluating publicly released models", "Evaluating unreleased models"];
const AGGREGATED_INDEX = /release-notes|\/migration\/|\/news\/?$/;
const RELEASE_CLAIM = /(?:today[ ,]+)?we(?:['’]re| are) (?:releasing|introducing)|today.{0,25}(?:releasing|introducing)|(?:is|are) (?:generally )?available (?:today|now)/gi;
const SUPPORTING_ARENA_PAGE = /\/faq\/?$|\/blog\/extended-arena\/?$/;
const MODEL_CONTEXT_BEFORE = 100;
const MODEL_CONTEXT_AFTER = 260;
const DATE_SEARCH_WINDOW = 1500;
const DOCUMENTS_PER_LAB = 2;

const BRIEF_WARNINGS = [
  "A document date is not automatically a public release date. Preserve access restrictions and verify which model the passage describes.",
  "A board snapshot predating a model's release cannot establish its post-release performance or listing lag. Same-day dates establish no intraday ordering.",
  "Do not treat absence from extracted rows as poor performance. No empirical release-to-first-listing lag has been measured by this extraction.",
];

const LAB_GAPS = [
  "First Arena listing date and empirical release-to-listing lag have not been established.",
  "Future launch before cutoff and first-place potential require separate evidence, not extrapolation from a release or market price.",
];

function hostname(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

function pathname(url: string): string {
  try { return new URL(url).pathname; } catch { return ""; }
}

function passage(text: string, start: number, length: number): EvidencePassage {
  const from = Math.max(0, start);
  return { start: from, end: Math.min(text.length, from + length), text: text.slice(from, from + length) };
}

function isPolicyPage(source: SourceDocument): boolean {
  return hostname(source.url) === "arena.ai" && /\/blog\/policy\/?$/.test(pathname(source.url)) && source.retrievalKind === "page";
}

function policyPassages(source: SourceDocument): EvidencePassage[] {
  return POLICY_TERMS.flatMap(term => {
    const heading = source.text.indexOf(`${term} .`);
    const offset = heading >= 0 ? heading : source.text.indexOf(term);
    if (offset < 0) return [];
    return [passage(source.text, offset, term.startsWith("Listing") ? 2700 : 1400)];
  });
}

function belongsToLab(source: SourceDocument, lab: Lab): boolean {
  const host = hostname(source.url);
  if (!lab.hosts.some(candidate => host === candidate || host.endsWith(`.${candidate}`))) return false;
  return !AGGREGATED_INDEX.test(source.url);
}

function releaseClaims(text: string, lab: Lab): RegExpExecArray[] {
  return [...text.matchAll(RELEASE_CLAIM)].filter(match => lab.model.test(text.slice(Math.max(0, match.index! - MODEL_CONTEXT_BEFORE), match.index! + MODEL_CONTEXT_AFTER)));
}

function dateOffsetNear(text: string, anchor: number): number | undefined {
  const published = new RegExp(`Published\\s+(${ENGLISH_DATE.source})`, "i").exec(text);
  if (published?.index !== undefined) return published.index;
  const windowStart = Math.max(0, anchor - DATE_SEARCH_WINDOW);
  const nearby = [...text.slice(windowStart, anchor).matchAll(new RegExp(ENGLISH_DATE.source, "gi"))].at(-1);
  return nearby ? windowStart + nearby.index! : undefined;
}

function claimPassages(text: string, claims: RegExpExecArray[]): EvidencePassage[] {
  if (!claims.length) return [passage(text, 0, 500)];
  return claims.slice(0, 2).map(claim => passage(text, Math.max(0, claim.index! - MODEL_CONTEXT_BEFORE), 1100));
}

interface LabDocumentRequest { source: SourceDocument; sourceNumber: number; lab: Lab; snapshot: ArenaSnapshot; asOf: string; }

function documentDating(text: string, anchor: number): { documentDate?: string; datePassage?: EvidencePassage } {
  const offset = dateOffsetNear(text, anchor);
  if (offset === undefined) return {};
  const datePassage = passage(text, offset, 100);
  return { documentDate: parseEnglishDate(datePassage.text), datePassage };
}

function retrievalKindOf(source: SourceDocument): string {
  return source.retrievalKind ?? "unspecified";
}

function labDocument(request: LabDocumentRequest): LabDocument[] {
  const { source, lab } = request;
  if (!belongsToLab(source, lab)) return [];
  const claims = releaseClaims(source.text, lab);
  if (!claims.length && source.retrievalKind !== "snippet") return [];
  const dating = documentDating(source.text, claims[0]?.index ?? 0);
  if (dating.documentDate && dating.documentDate > request.asOf.slice(0, 10)) return [];
  return [{ sourceNumber: request.sourceNumber, url: source.url, kind: retrievalKindOf(source), ...dating,
    boardRelation: compareBoardDate(request.snapshot.dataDate, dating.documentDate), passages: claimPassages(source.text, claims) }];
}

function byPageThenRecency(left: LabDocument, right: LabDocument): number {
  return Number(right.kind === "page") - Number(left.kind === "page") || (right.documentDate ?? "").localeCompare(left.documentDate ?? "");
}

function labEvidence(lab: Lab, sources: SourceDocument[], snapshot: ArenaSnapshot, asOf: string): LabEvidence {
  const candidates = sources.flatMap((source, index) => labDocument({ source, sourceNumber: index + 1, lab, snapshot, asOf }));
  const documents = candidates.sort(byPageThenRecency).slice(0, DOCUMENTS_PER_LAB);
  const missingPage = documents.some(document => document.kind === "page") ? [] : ["No primary-page release passage extracted; snippets alone do not verify release."];
  return { lab: lab.name, documents, gaps: [...missingPage, ...LAB_GAPS] };
}

export function buildArenaEvidenceBrief(sources: SourceDocument[], snapshot: ArenaSnapshot, asOf: string): ArenaEvidenceBrief {
  return {
    warnings: [`Board data date ${snapshot.dataDate ?? "unknown"}; run cutoff ${asOf}. Retrieval time is NOT the board data date.`, ...BRIEF_WARNINGS],
    policy: sources.flatMap((source, index) => isPolicyPage(source) ? [{ sourceNumber: index + 1, url: source.url, passages: policyPassages(source) }] : []),
    labs: LABS.map(lab => labEvidence(lab, sources, snapshot, asOf)),
  };
}

export function arenaSupportingText(sources: SourceDocument[]): string {
  return sources.flatMap((source, index) => hostname(source.url) === "arena.ai" && !isArenaTarget(source.url) && SUPPORTING_ARENA_PAGE.test(pathname(source.url))
    ? [`SOURCE ${index + 1} (${retrievalKindOf(source)}) ${source.url}\n${source.text.slice(0, 10000)}`] : []).join("\n\n");
}
