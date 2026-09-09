import { candidateName } from "./market-policy.ts";
import { resolutionQueries, resolutionUnits } from "./resolution-research.ts";
import type { PolymarketEvent, ResearchMarketRequest, ResearchRun, ResearchUnit, SearchProvider, SourceDocument } from "./types.ts";

const CLASS_II_2026 = "Alabama,Alaska,Arkansas,Colorado,Delaware,Georgia,Idaho,Illinois,Iowa,Kansas,Kentucky,Louisiana,Maine,Massachusetts,Michigan,Minnesota,Mississippi,Montana,Nebraska,New Hampshire,New Jersey,New Mexico,North Carolina,Oklahoma,Oregon,Rhode Island,South Carolina,South Dakota,Tennessee,Texas,Virginia,West Virginia,Wyoming".split(",");
const SPECIAL_ELECTIONS_2026 = ["Florida special", "Ohio special"];
const PLACEHOLDER_CANDIDATE = /^(?:Other|another person|Candidate [A-Z]|Party [A-Z])$/i;
const SEARCH_TIMEOUT_MS = 30_000;
const RESULTS_PER_QUERY = 4;
const EXCERPT_LIMIT = 6500;
const EXCERPT_CHUNK = 700;
const EXCERPT_CHUNKS = 8;
const EXCERPT_PREFIX = 200;
const SALIENT_PASSAGE = /\d\s*%|probability|nominee|incumbent/i;

function isSenateControlEvent(event: PolymarketEvent): boolean {
  return /senate/i.test(event.title) && /2026/.test(event.title) && /control|win the senate/i.test(event.title);
}

function raceUnit(name: string): ResearchUnit {
  return {
    name: `${name} Senate election 2026`, kind: "race",
    question: `Verify that the ${name} Senate election is scheduled for the 120th Congress. Identify incumbent party, all major nominees and relevant independents, dated polls, exact race win probabilities if available, competitive factors, runoff rules and party-caucus implications. Clearly separate seat retention from flips.`,
    queries: [`${name} Senate election 2026 candidates incumbent September polls`, `${name} Senate election 2026 winner odds forecast probability Polymarket September`],
  };
}

export function candidateUnit(event: PolymarketEvent, name: string, unlisted: boolean): ResearchUnit {
  const role = event.title.replace(/^Who will .*?pick as (?:the )?next /i, "").replace(/\?$/, "");
  return { name, kind: unlisted ? "unlisted_candidate" : "candidate",
    question: `Research ${name} specifically for ${event.title}. Establish current role, relevant experience, access to the decision-maker, dated evidence of actual consideration, availability, statements/denials, obstacles and counterevidence. Distinguish reported consideration from a merely plausible biography. Never include selection odds or expert rankings.`,
    queries: [`"${name}" "${role}" appointment consideration 2026 -odds -betting`, `"${name}" current role White House September 2026 statements replacement`],
  };
}

export function initialUnits(event: PolymarketEvent): ResearchUnit[] {
  const resolution = resolutionUnits(event);
  if (resolution) return resolution;
  if (isSenateControlEvent(event)) return [...CLASS_II_2026.map(name => `${name} regular`), ...SPECIAL_ELECTIONS_2026].map(raceUnit);
  const candidates = [...new Set((event.markets ?? []).map(candidateName).filter(name => name && !PLACEHOLDER_CANDIDATE.test(name)))];
  return candidates.length > 1 ? candidates.map(name => candidateUnit(event, name, false)) : [];
}

const SENATE_DISCOVERY = [
  "2026 Senate elections all 35 seats regular special elections incumbent party candidates",
  "2026 Senate election map Republican Democratic seats not up election vice president tie caucus independents",
];

const AGI_DISCOVERY = [
  "site:openai.com AGI announcement September 2026 official representative",
  "OpenAI AGI Greg Brockman Sam Altman September 2026 full statement interview",
  "OpenAI AGI announcement definition conditions Microsoft agreement 2026",
];

function candidateDiscovery(title: string): string[] {
  return [
    `${title} replacement shortlist new names potential candidates -odds -betting -polymarket`,
    `${title} site:whitehouse.gov announcement`,
    `${title} interviews considered dark horse unlisted candidates -odds -betting`,
  ];
}

export function discoveryQueries(event: PolymarketEvent): string[] {
  const resolution = resolutionQueries(event);
  if (resolution) return resolution;
  if (/senate/i.test(event.title) && /2026/.test(event.title)) return SENATE_DISCOVERY;
  if (initialUnits(event).some(unit => unit.kind === "candidate")) return candidateDiscovery(event.title);
  if (/\bAGI\b/.test(event.title)) return AGI_DISCOVERY;
  return [`${event.title} underlying causes milestones scenarios primary evidence`, `${event.title} official announcement latest developments`];
}

export async function searchQueries(search: SearchProvider | undefined, queries: string[], searches: NonNullable<ResearchRun["retrieval"]>["searches"]): Promise<SourceDocument[]> {
  if (!search) return [];
  const results = await Promise.allSettled(queries.map(query => search.search(query, { limit: RESULTS_PER_QUERY, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) })));
  return results.flatMap((result, index) => {
    searches.push({ query: queries[index]!, status: result.status === "fulfilled" ? "complete" : "failed", documents: result.status === "fulfilled" ? result.value.length : 0 });
    return result.status === "fulfilled" ? result.value : [];
  });
}

export function componentExcerpt(text: string, question: string): string {
  if (text.length <= EXCERPT_LIMIT) return text;
  const terms = question.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const chunks = Array.from({ length: Math.ceil(text.length / EXCERPT_CHUNK) }, (_, index) => {
    const content = text.slice(index * EXCERPT_CHUNK, (index + 1) * EXCERPT_CHUNK);
    const score = terms.filter(term => content.toLowerCase().includes(term)).length + (SALIENT_PASSAGE.test(content) ? 1 : 0);
    return { index, content, score };
  });
  const selected = chunks.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, EXCERPT_CHUNKS).sort((a, b) => a.index - b.index);
  return `${text.slice(0, EXCERPT_PREFIX)}\n[Selected passages]\n${selected.map(chunk => chunk.content).join("\n[...]\n")}`;
}

export interface NamedUnit { name: string; question: string; queries: unknown; }

const MAX_NAME_LENGTH = 160;
const MAX_QUERY_LENGTH = 400;
const MAX_DEPENDENCY_QUERIES = 2;

export function parseUnits(text: string, missingMessage: string): unknown[] {
  const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as { units?: unknown[] };
  if (!Array.isArray(parsed.units)) throw new Error(missingMessage);
  return parsed.units;
}

export function namedUnit(value: unknown): NamedUnit | undefined {
  const unit = value as Record<string, unknown> | null;
  if (!unit || typeof unit.name !== "string" || typeof unit.question !== "string") return undefined;
  if (!unit.name.trim() || unit.name.length > MAX_NAME_LENGTH) return undefined;
  return { name: unit.name, question: unit.question, queries: unit.queries };
}

export function dependencyQueries(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || !raw.length || !raw.every(query => typeof query === "string")) return undefined;
  return (raw as string[]).slice(0, MAX_DEPENDENCY_QUERIES).map(query => query.slice(0, MAX_QUERY_LENGTH));
}

const MAX_QUERIES = 8;

export function retrievalQueries(event: PolymarketEvent, request: ResearchMarketRequest, topicMode: boolean): string[] {
  const effort = request.effort ?? "low";
  const defaults = !topicMode && effort === "high" ? discoveryQueries(event) : [event.title, `${event.title} ${event.resolutionSource ?? "primary sources"}`];
  if (effort !== "low") defaults.push(`${event.title} latest developments`, `${event.title} contrary evidence uncertainty`);
  if (effort === "high") defaults.push(`${event.title} historical data methodology`, `${event.title} limitations revisions alternative explanations`);
  const requested = request.queries?.length ? request.queries : defaults;
  return [...new Set(requested.map(query => query.trim()).filter(Boolean))].slice(0, MAX_QUERIES);
}
