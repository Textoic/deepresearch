import type { SourceDocument } from "./types.ts";

/** Render bare, valid source IDs; never invent an absent source or alter an existing URL. */
export function linkSourceReferences(text: string, sources: SourceDocument[]): string {
  return text.replace(/\[((?:Source\s+\d+)(?:\s*,\s*(?:Source\s+)?\d+)*)\](?!\()/g, (original, ids: string) => {
    const numbers = [...ids.matchAll(/\d+/g)].map(m => Number(m[0]));
    if (numbers.some(n => !sources[n - 1])) return original;
    return numbers.map(n => `[Source ${n}](${sources[n - 1]!.url})`).join(", ");
  });
}
