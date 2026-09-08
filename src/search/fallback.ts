import type { SearchProvider, SourceDocument } from "../types.ts";

export interface NamedSearchProvider { id: string; provider: SearchProvider; }

export class FallbackSearchProvider implements SearchProvider {
  private readonly chain: NamedSearchProvider[];
  readonly diagnostics: string[] = [];

  constructor(chain: NamedSearchProvider[]) {
    if (!chain.length) throw new Error("A fallback search chain needs at least one provider.");
    this.chain = chain;
  }

  async search(query: string, options: { limit: number; signal?: AbortSignal }): Promise<SourceDocument[]> {
    const failures: string[] = [];
    let answered = false;
    for (const { id, provider } of this.chain) {
      try {
        const sources = await provider.search(query, options);
        answered = true;
        if (sources.length) return sources;
      } catch (error) {
        const reason = `${id}: ${error instanceof Error ? error.message : String(error)}`;
        failures.push(reason);
        this.diagnostics.push(reason);
      }
    }
    if (answered) return [];
    throw new Error(`Every search provider failed. ${failures.join(" | ")}`);
  }
}
