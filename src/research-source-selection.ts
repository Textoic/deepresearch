import { extractSourceUrls } from "./source-adapters.ts";
import { tierOf } from "./source-tier.ts";
import type { NumberedSource } from "./report-prompt.ts";
import type { PolymarketEvent, SourceDocument } from "./types.ts";

const GENERIC_TERMS = new Set(["will", "with", "from", "this", "that", "what", "when", "which", "have", "does", "next", "military", "action", "against", "final", "leader", "time"]);
const FRESH_SOURCE_SLOTS = 3;

function subjectTerms(event: PolymarketEvent): string[] {
  return (event.title.toLowerCase().match(/[\p{L}]{4,}/gu) ?? []).filter(term => !GENERIC_TERMS.has(term));
}

function isDatedRelevant(source: SourceDocument, terms: string[]): boolean {
  if (tierOf(source) > 2 || !Number.isFinite(Date.parse(source.publishedAt ?? ""))) return false;
  const title = source.title?.toLowerCase() ?? "";
  return terms.some(term => title.includes(term));
}

export function prioritySources(sources: SourceDocument[], event: PolymarketEvent): NumberedSource[] {
  const numbered = sources.map((source, index) => ({ number: index + 1, source }));
  const linked = new Set(extractSourceUrls(event.clarification ?? ""));
  const terms = subjectTerms(event);
  const fresh = numbered.filter(entry => isDatedRelevant(entry.source, terms))
    .sort((a, b) => Date.parse(b.source.publishedAt!) - Date.parse(a.source.publishedAt!)).slice(0, FRESH_SOURCE_SLOTS);
  return [...numbered.filter(entry => linked.has(entry.source.url)), ...fresh];
}

export function uniqueSources(entries: NumberedSource[], limit: number): NumberedSource[] {
  return [...new Map(entries.map(entry => [entry.number, entry])).values()].slice(0, limit);
}
