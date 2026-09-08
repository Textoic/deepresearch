import { canonicalSourceUrl } from "./evidence.ts";
import type { SourceDocument } from "./types.ts";

export interface UnfoundedCitation { number: number; url: string; reason: "no such source" | "url does not match the source"; }

const WRITTEN_CITATION = /\[Source\s+(\d+)\]\(([^)\s]+)\)/g;

function pointsAtSource(source: SourceDocument | undefined, url: string): boolean {
  if (!source) return false;
  const written = canonicalSourceUrl(url);
  return canonicalSourceUrl(source.url).startsWith(written);
}

export function unfoundedCitations(text: string, sources: SourceDocument[]): UnfoundedCitation[] {
  const seen = new Map<string, UnfoundedCitation>();
  for (const [, id, url] of text.matchAll(WRITTEN_CITATION)) {
    const number = Number(id);
    const source = sources[number - 1];
    if (pointsAtSource(source, url!)) continue;
    seen.set(`${number}|${url}`, { number, url: url!, reason: source ? "url does not match the source" : "no such source" });
  }
  return [...seen.values()];
}

export function citationIntegrityLimitation(unfounded: UnfoundedCitation[]): string {
  const examples = unfounded.slice(0, 3).map(citation => `[Source ${citation.number}](${citation.url}) — ${citation.reason}`).join("; ");
  return `${unfounded.length} citation(s) in this report do not correspond to a retrieved source and their links must not be trusted: ${examples}.`;
}

export function linkSourceReferences(text: string, sources: SourceDocument[]): string {
  return text.replace(/\[((?:Source\s+\d+)(?:\s*,\s*(?:Source\s+)?\d+)*)\](?!\()/g, (original, ids: string) => {
    const numbers = [...ids.matchAll(/\d+/g)].map(m => Number(m[0]));
    if (numbers.some(n => !sources[n - 1])) return original;
    return numbers.map(n => `[Source ${n}](${sources[n - 1]!.url})`).join(", ");
  });
}
